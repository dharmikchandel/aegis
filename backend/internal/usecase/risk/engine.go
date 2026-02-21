package risk

import (
	"aegis-backend/internal/domain"
	"math"
	"sync"
	"time"
)

// TimeBand defines a multiplier for a specific time range.
type TimeBand struct {
	StartHour  int // Inclusive (0-23)
	EndHour    int // Exclusive (0-23). If EndHour < StartHour, it wraps past midnight
	Multiplier float64
}

// Config holds the thresholds for anomaly detection
type Config struct {
	MaxWindowDuration    time.Duration // E.g., 30 * time.Second
	StopSpeedThreshold   float64       // E.g., 0.5 m/s
	StopDuration         time.Duration // E.g., 20 * time.Second
	AccelSpikeThreshold  float64       // E.g., 2.5 g
	DeviationBaseDegrees float64       // E.g., simple radius difference for MVP
	TimeBands            []TimeBand
}

func DefaultConfig() Config {
	return Config{
		MaxWindowDuration:   30 * time.Second,
		StopSpeedThreshold:  0.6,              // < 0.6 m/s average is considered stopped
		StopDuration:        20 * time.Second, // 20s of stop = risk
		AccelSpikeThreshold: 15.0,             // m/s^2 (approx 1.5g)
		TimeBands: []TimeBand{
			{StartHour: 6, EndHour: 18, Multiplier: 1.0},  // 6:00 AM – 6:00 PM
			{StartHour: 18, EndHour: 22, Multiplier: 1.2}, // 6:00 PM – 10:00 PM
			{StartHour: 22, EndHour: 2, Multiplier: 1.6},  // 10:00 PM – 2:00 AM
			{StartHour: 2, EndHour: 6, Multiplier: 1.4},   // 2:00 AM – 6:00 AM
		},
	}
}

// SessionState tracks the sliding window and specific variables for a user
type SessionState struct {
	SessionID string
	Window    []*domain.Telemetry
	mu        sync.RWMutex

	// Escalation tracking
	WarningStartTime time.Time
	HasAcknowledged  bool
	IsDanger         bool
}

// Engine evaluates telemetry streams
type Engine struct {
	config   Config
	sessions map[string]*SessionState
	mu       sync.RWMutex
}

func NewEngine(cfg Config) *Engine {
	return &Engine{
		config:   cfg,
		sessions: make(map[string]*SessionState),
	}
}

func (e *Engine) getOrCreateSession(sessionID string) *SessionState {
	e.mu.Lock()
	defer e.mu.Unlock()

	if s, exists := e.sessions[sessionID]; exists {
		return s
	}

	s := &SessionState{
		SessionID: sessionID,
		Window:    make([]*domain.Telemetry, 0),
	}
	e.sessions[sessionID] = s
	return s
}

func (e *Engine) ProcessTelemetry(t *domain.Telemetry) *domain.RiskUpdate {
	state := e.getOrCreateSession(t.SessionID)

	state.mu.Lock()
	// Add to window
	state.Window = append(state.Window, t)

	// Prune sliding window (Keep only last MaxWindowDuration)
	cutoff := t.Timestamp.Add(-e.config.MaxWindowDuration)
	filtered := state.Window[:0]
	for _, pt := range state.Window {
		if pt.Timestamp.After(cutoff) || pt.Timestamp.Equal(cutoff) {
			filtered = append(filtered, pt)
		}
	}
	state.Window = filtered
	state.mu.Unlock()

	return e.evaluate(state, t)
}

func (e *Engine) evaluate(state *SessionState, latest *domain.Telemetry) *domain.RiskUpdate {
	state.mu.Lock()
	defer state.mu.Unlock()

	var basePoints float64 = 0
	var reasons []string

	// 1. Sudden Stop Detection
	if e.isSuddenlyStopped(state.Window) {
		basePoints += 50
		reasons = append(reasons, "Sudden Stop Detected (>20s)")
	}

	// 2. Acceleration Spike Detection
	if latest.AccelerationMagnitude > e.config.AccelSpikeThreshold {
		basePoints += 60
		reasons = append(reasons, "Acceleration Spike Detected")
	}

	// 3. Route Deviation Detection
	// For MVP, we'll simulate a simple radius check from origin if we had the origin.
	// We will skip full polyline math for the MVP backend but leave the hook.
	// If needed we can feed expected path to state.

	// 4. Circadian Risk Multiplier
	multiplier := e.getCircadianMultiplier(latest.Timestamp)

	finalScore := basePoints * multiplier

	rState := domain.RiskStateNormal
	var escalationTimer int = 0

	// Handle explicit clear
	if state.HasAcknowledged {
		rState = domain.RiskStateNormal
		state.HasAcknowledged = false // Ready for next anomaly
		finalScore = 0                // Drop visually for this frame
	} else if state.IsDanger {
		rState = domain.RiskStateDanger
		finalScore = math.Max(finalScore, 100) // Lock score visually
	} else if !state.WarningStartTime.IsZero() {
		// Countdown active
		rState = domain.RiskStateWarning
		finalScore = math.Max(finalScore, 50) // Keep score artificially high

		elapsed := time.Since(state.WarningStartTime)
		remaining := 20 - int(elapsed.Seconds())

		if remaining <= 0 {
			state.IsDanger = true
			rState = domain.RiskStateDanger
			finalScore = 100
			escalationTimer = 0
		} else {
			escalationTimer = remaining
		}
	} else if finalScore >= 50 {
		// New breach
		state.WarningStartTime = time.Now()
		rState = domain.RiskStateWarning
		escalationTimer = 20
	} else if finalScore > 0 {
		rState = domain.RiskStateWarning
	}

	return &domain.RiskUpdate{
		SessionID:       state.SessionID,
		RiskScore:       math.Min(finalScore, 100), // Cap at 100
		BasePoints:      basePoints,
		TimeMultiplier:  multiplier,
		State:           rState,
		Reasons:         reasons,
		EscalationTimer: escalationTimer,
		EvaluatedAt:     time.Now(),
	}
}

// AcknowledgeSafety lets a user clear their escalated danger state
func (e *Engine) AcknowledgeSafety(sessionID string) {
	state := e.getOrCreateSession(sessionID)
	state.mu.Lock()
	defer state.mu.Unlock()

	state.HasAcknowledged = true
	state.IsDanger = false
	state.WarningStartTime = time.Time{}
	// Flush the sliding window so anomalies must build up fresh
	state.Window = make([]*domain.Telemetry, 0)
}

func (e *Engine) isSuddenlyStopped(window []*domain.Telemetry) bool {
	if len(window) < 2 {
		return false
	}

	latestTime := window[len(window)-1].Timestamp
	stopCutoff := latestTime.Add(-e.config.StopDuration)

	// First, check if our window even spans the required stop duration
	oldestTime := window[0].Timestamp
	if oldestTime.After(stopCutoff) {
		// We don't have enough history to trigger a 20s stop
		return false
	}

	var speedSum float64 = 0
	var count int = 0
	var totalDistance float64 = 0
	var prevPt *domain.Telemetry

	for _, pt := range window {
		if pt.Timestamp.After(stopCutoff) || pt.Timestamp.Equal(stopCutoff) {
			if prevPt != nil {
				totalDistance += haversine(prevPt.Latitude, prevPt.Longitude, pt.Latitude, pt.Longitude)
			}
			prevPt = pt
			speedSum += pt.Speed
			count++
		}
	}

	if count < 2 {
		return false
	}

	avgSpeed := speedSum / float64(count)
	if avgSpeed >= e.config.StopSpeedThreshold {
		return false // Average speed was too high
	}

	// If cumulative distance is less than 3 meters over 20 seconds, classify as sudden stop
	if totalDistance < 3.0 {
		return true
	}

	return false
}

func haversine(lat1, lon1, lat2, lon2 float64) float64 {
	const R = 6371e3 // Earth radius in meters
	dLat := (lat2 - lat1) * math.Pi / 180.0
	dLon := (lon2 - lon1) * math.Pi / 180.0
	lat1Rad := lat1 * math.Pi / 180.0
	lat2Rad := lat2 * math.Pi / 180.0

	a := math.Sin(dLat/2)*math.Sin(dLat/2) +
		math.Sin(dLon/2)*math.Sin(dLon/2)*math.Cos(lat1Rad)*math.Cos(lat2Rad)
	c := 2 * math.Atan2(math.Sqrt(a), math.Sqrt(1-a))

	return R * c
}

// getCircadianMultiplier applies the configured time bands to event risk scores
func (e *Engine) getCircadianMultiplier(t time.Time) float64 {
	hour := t.Hour()

	for _, band := range e.config.TimeBands {
		if band.StartHour < band.EndHour {
			if hour >= band.StartHour && hour < band.EndHour {
				return band.Multiplier
			}
		} else { // Wraps past midnight
			if hour >= band.StartHour || hour < band.EndHour {
				return band.Multiplier
			}
		}
	}

	return 1.0 // Fallback if no band matches
}
