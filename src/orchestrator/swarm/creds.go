package swarm

import (
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"
)

// insecureCreds is plaintext gRPC: run the swarm on a private network, or terminate TLS in front of it.
func insecureCreds() credentials.TransportCredentials { return insecure.NewCredentials() }
