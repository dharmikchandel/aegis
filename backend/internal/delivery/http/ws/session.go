package ws

import (
	"aegis-backend/internal/domain"
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/gorilla/websocket"
)

const (
	// Time allowed to write a message to the peer.
	writeWait = 10 * time.Second

	// Time allowed to read the next pong message from the peer.
	pongWait = 60 * time.Second

	// Send pings to peer with this period. Must be less than pongWait.
	pingPeriod = (pongWait * 9) / 10

	// Maximum message size allowed from peer.
	maxMessageSize = 512 * 1024
)

type Session struct {
	conn   *websocket.Conn
	server *Server
	ctx    context.Context
	cancel context.CancelFunc
	send   chan []byte
}

func NewSession(conn *websocket.Conn, server *Server) *Session {
	ctx, cancel := context.WithCancel(context.Background())
	return &Session{
		conn:   conn,
		server: server,
		ctx:    ctx,
		cancel: cancel,
		send:   make(chan []byte, 256),
	}
}

func (s *Session) Start() {
	log.Printf("New WebSocket session started (Client: %s)", s.conn.RemoteAddr().String())

	// Goroutine to monitor context for graceful shutdown
	go s.monitorContext()

	// Goroutine for sending pings to keep connection alive
	go s.writePump()

	// Read loop in current goroutine
	s.readPump()
}

func (s *Session) monitorContext() {
	<-s.ctx.Done()

	// Graceful shutdown on context close
	s.conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, "Server shutting down"), time.Now().Add(writeWait))
	s.conn.Close()
}

func (s *Session) writePump() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		s.conn.Close()
	}()

	for {
		select {
		case <-s.ctx.Done():
			return
		case message, ok := <-s.send:
			s.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				// The server closed the channel.
				s.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}

			w, err := s.conn.NextWriter(websocket.TextMessage)
			if err != nil {
				return
			}
			w.Write(message)

			// Add queued chat messages to the current websocket message.
			n := len(s.send)
			for i := 0; i < n; i++ {
				w.Write([]byte{'\n'})
				w.Write(<-s.send)
			}

			if err := w.Close(); err != nil {
				return
			}
		case <-ticker.C:
			s.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := s.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func (s *Session) readPump() {
	defer func() {
		s.server.removeSession(s)
		s.cancel() // Ensure other goroutines are cleaned up via context
		s.conn.Close()
		log.Printf("WebSocket session closed (Client: %s)", s.conn.RemoteAddr().String())
	}()

	s.conn.SetReadLimit(maxMessageSize)
	s.conn.SetReadDeadline(time.Now().Add(pongWait))
	s.conn.SetPongHandler(func(string) error { s.conn.SetReadDeadline(time.Now().Add(pongWait)); return nil })

	for {
		_, message, err := s.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("error: %v", err)
			}
			break
		}

		// Check if it's a simple SAFE string or ClientAction JSON
		var action domain.ClientAction
		isSafeAck := false

		if string(message) == "SAFE" {
			isSafeAck = true
		} else if err := json.Unmarshal(message, &action); err == nil && action.Action == "SAFE_ACK" {
			isSafeAck = true
		}

		if isSafeAck {
			// We need the session ID for this. Since we might not have it strictly from a string
			// we will use a fallback or assume the client sends the session ID in the action,
			// but for this MVP mock where the session is "demo_user", we just pass it hardcoded
			// or extract from the last known frame. Let's grab it from the connection logic.
			// Ideally the Action JSON carries it, but "SAFE" string doesn't.
			s.server.risk.AcknowledgeSafety("demo_user") // Hardcoded for this MVP slice
			continue
		}

		// Log incoming JSON telemetry payload
		var telemetry domain.Telemetry
		if err := json.Unmarshal(message, &telemetry); err != nil {
			log.Printf("Invalid JSON payload received: %v", err)
			continue
		}

		// Ensure timestamp is parsed properly if needed, although unmarshal handles standard ISO8601
		log.Printf("Received Telemetry: %+v", telemetry)

		// 1. Broadcast the original telemetry so the map updates
		s.server.broadcast <- message

		// 2. Evaluate through the Risk Engine
		riskUpdate := s.server.risk.ProcessTelemetry(&telemetry)

		// 3. Broadcast the Risk Update so the stats panel updates
		riskBytes, err := json.Marshal(riskUpdate)
		if err == nil {
			log.Printf("BROADCASTING RISK: %s", string(riskBytes))
			s.server.broadcast <- riskBytes
		} else {
			log.Printf("Failed to marshal risk update: %v", err)
		}
	}
}

func (s *Session) Close() {
	s.cancel()
}
