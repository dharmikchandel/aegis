package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"aegis-backend/internal/delivery/http/ws"
)

func main() {
	fmt.Println("Aegis Backend initializing...")

	wsServer := ws.NewServer()
	go wsServer.Run()

	mux := http.NewServeMux()

	// Health check endpoint
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("OK"))
	})

	// WebSocket endpoint
	mux.HandleFunc("/ws", wsServer.HandleWebSocket)

	server := &http.Server{
		Addr:    ":8080",
		Handler: mux,
	}

	// Run server in a goroutine so that it doesn't block
	go func() {
		fmt.Println("Server listening on :8080")
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("listen: %s\n", err)
		}
	}()

	// Wait for interrupt signal to gracefully shutdown the server
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit
	log.Println("Shutting down server...")

	// Create a deadline to wait for
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// Shutdown WebSocket server sessions gracefully
	wsServer.Shutdown(ctx)

	// Shutdown the HTTP server
	if err := server.Shutdown(ctx); err != nil {
		log.Fatal("Server forced to shutdown:", err)
	}

	log.Println("Server exiting gracefully")
}
