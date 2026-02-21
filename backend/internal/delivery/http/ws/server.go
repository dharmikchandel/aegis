package ws

import (
	"aegis-backend/internal/usecase/risk"
	"context"
	"log"
	"net/http"
	"sync"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin: func(r *http.Request) bool {
		// allow all connections for during development
		return true
	},
}

type Server struct {
	sessions  map[*Session]bool
	broadcast chan []byte
	mu        sync.Mutex
	risk      *risk.Engine
}

func NewServer() *Server {
	return &Server{
		sessions:  make(map[*Session]bool),
		broadcast: make(chan []byte),
		risk:      risk.NewEngine(risk.DefaultConfig()),
	}
}

func (s *Server) Run() {
	for {
		message := <-s.broadcast
		s.mu.Lock()
		for session := range s.sessions {
			select {
			case session.send <- message:
			default:
				close(session.send)
				delete(s.sessions, session)
			}
		}
		s.mu.Unlock()
	}
}

func (s *Server) HandleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("upgrade error:", err)
		return
	}

	session := NewSession(conn, s)
	s.addSession(session)

	// Run session handlers
	go session.Start()
}

func (s *Server) addSession(session *Session) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sessions[session] = true
}

func (s *Server) removeSession(session *Session) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.sessions, session)
}

func (s *Server) Shutdown(ctx context.Context) {
	s.mu.Lock()
	defer s.mu.Unlock()
	log.Println("Shutting down WebSocket server, closing sessions...")
	for session := range s.sessions {
		session.Close()
		delete(s.sessions, session)
	}
}
