package preview

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// HTTPRegistrar publishes routes to a preview-router over its control API.
type HTTPRegistrar struct {
	RouterURL string // e.g. http://localhost:8790
	Room      string
	Secret    string // X-Preview-Secret; empty in dev-open mode
	Client    *http.Client
}

func NewHTTPRegistrar(routerURL, room, secret string) *HTTPRegistrar {
	return &HTTPRegistrar{
		RouterURL: routerURL,
		Room:      room,
		Secret:    secret,
		Client:    &http.Client{Timeout: 5 * time.Second},
	}
}

type registerBody struct {
	Room   string `json:"room"`
	Port   int    `json:"port"`
	Target string `json:"target,omitempty"`
	Name   string `json:"name,omitempty"`
}

func (h *HTTPRegistrar) Register(port int, target, name string) error {
	return h.post("/v1/register", registerBody{Room: h.Room, Port: port, Target: target, Name: name})
}

func (h *HTTPRegistrar) Unregister(port int) error {
	return h.post("/v1/unregister", registerBody{Room: h.Room, Port: port})
}

func (h *HTTPRegistrar) post(path string, body registerBody) error {
	buf, err := json.Marshal(body)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, h.RouterURL+path, bytes.NewReader(buf))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if h.Secret != "" {
		req.Header.Set("X-Preview-Secret", h.Secret)
	}
	res, err := h.Client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		return fmt.Errorf("preview-router %s: %s", path, res.Status)
	}
	return nil
}
