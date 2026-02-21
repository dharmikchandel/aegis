package escalation

import (
	"aegis-backend/internal/domain"
	"context"
	"fmt"
	"log"
	"sync"
	"time"
)

// ClientNotifier defines how the Escalation service communicates with the client via the gateway.
type ClientNotifier interface {
	PromptUser(sessionID string, message string) error
}

// Service manages escalating risk events into emergency actions.
type Service struct {
	notifier  ClientNotifier
	threshold float64
	responses map[string]chan bool
	mu        sync.RWMutex
}

func NewService(notifier ClientNotifier, threshold float64) *Service {
	return &Service{
		notifier:  notifier,
		threshold: threshold,
		responses: make(map[string]chan bool),
	}
}

// ProcessRiskUpdate evaluates a risk update and triggers the escalation flow if necessary.
func (s *Service) ProcessRiskUpdate(ctx context.Context, update *domain.RiskUpdate) {
	if update.State == domain.RiskStateDanger || update.RiskScore >= s.threshold {
		s.mu.Lock()
		// If we are already handling an escalation for this session, do not trigger a duplicate.
		if _, exists := s.responses[update.SessionID]; exists {
			s.mu.Unlock()
			return
		}

		responseChan := make(chan bool, 1)
		s.responses[update.SessionID] = responseChan
		s.mu.Unlock()

		go s.handleEscalation(ctx, update.SessionID, responseChan)
	}
}

func (s *Service) handleEscalation(ctx context.Context, sessionID string, responseChan chan bool) {
	// Ensure we cleanup the active escalation tracking when this function exits.
	defer func() {
		s.mu.Lock()
		delete(s.responses, sessionID)
		s.mu.Unlock()
	}()

	log.Printf("[ESCALATION] Triggered for session %s. Prompting user...", sessionID)

	// Send prompt to device
	err := s.notifier.PromptUser(sessionID, "Are you safe?")
	if err != nil {
		log.Printf("[ESCALATION] Failed to prompt user %s: %v", sessionID, err)
		// We proceed to timeout anyway — if we can't reach them, it's safer to escalate.
	}

	// Wait for user response, context timeout, or the 10-second escalation timer.
	select {
	case <-ctx.Done():
		log.Printf("[ESCALATION] Context cancelled for session %s, aborting.", sessionID)
		return
	case response := <-responseChan:
		if response {
			log.Printf("[ESCALATION] User %s confirmed they are safe. Escalation aborted.", sessionID)
			return
		}
	case <-time.After(10 * time.Second):
		log.Printf("[ESCALATION] Timeout! No response from user %s in 10 seconds.", sessionID)
		s.triggerEmergencyDispatch(sessionID)
	}
}

// ReceiveClientResponse is called by the gateway when a user clicks "I am safe".
func (s *Service) ReceiveClientResponse(sessionID string, isSafe bool) {
	s.mu.RLock()
	ch, exists := s.responses[sessionID]
	s.mu.RUnlock()

	if exists {
		// Non-blocking send to ensure we don't hold up the WebSocket read loop
		// if the channel is full (e.g., duplicated messages).
		select {
		case ch <- isSafe:
		default:
		}
	}
}

func (s *Service) triggerEmergencyDispatch(sessionID string) {
	log.Printf("[EMERGENCY] !!! DISPATCHING HELP FOR SESSION %s !!!", sessionID)

	// Simulate SMS or Webhook via console output.
	fmt.Printf("\n--- SMS NOTIFICATION MOCK ---\nTo: Emergency Contacts\nMsg: User %s has not responded to an emergency prompt and has triggered high risk anomalies. Please check on them immediately.\n-----------------------------\n\n", sessionID)
}
