package domain

import "time"

// Telemetry represents a single data point streaming from the client.
type Telemetry struct {
	SessionID             string    `json:"sessionId"`
	Latitude              float64   `json:"latitude"`
	Longitude             float64   `json:"longitude"`
	Speed                 float64   `json:"speed"`
	AccelerationMagnitude float64   `json:"accelerationMagnitude"`
	Timestamp             time.Time `json:"timestamp"`
}

// RiskUpdate represents an outgoing evaluation from the risk engine.
type RiskUpdate struct {
	SessionID       string    `json:"sessionId"`
	RiskScore       float64   `json:"riskScore"`
	BasePoints      float64   `json:"basePoints"`
	TimeMultiplier  float64   `json:"timeMultiplier"`
	State           RiskState `json:"state"`
	Reasons         []string  `json:"reasons"`
	EscalationTimer int       `json:"escalationTimer,omitempty"` // Seconds remaining before DANGER
	EvaluatedAt     time.Time `json:"evaluatedAt"`
}

// ClientAction represents a command sent FROM the mobile app to the backend.
type ClientAction struct {
	Action string `json:"action"` // e.g., "SAFE_ACK"
}

type RiskState string

const (
	RiskStateNormal  RiskState = "NORMAL"
	RiskStateWarning RiskState = "WARNING"
	RiskStateDanger  RiskState = "DANGER"
)
