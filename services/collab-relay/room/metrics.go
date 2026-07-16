package room

import (
	"context"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
)

// Package-level instruments via the global meter: no-ops until main installs
// a provider (obs.InitMetrics), so tests need no wiring. Instrument metrics,
// not spans, on the hot path (blueprint doc 10 §1: tracing keystrokes would
// melt the trace store).
var (
	meter = otel.Meter("collab-relay")

	mConns, _       = meter.Int64UpDownCounter("relay_connections", metric.WithDescription("open websocket connections"))
	mRooms, _       = meter.Int64UpDownCounter("relay_rooms", metric.WithDescription("live rooms"))
	mFramesIn, _    = meter.Int64Counter("relay_frames_in", metric.WithDescription("frames received, by channel"))
	mBytesIn, _     = meter.Int64Counter("relay_bytes_in", metric.WithDescription("payload bytes received, by channel"))
	mBroadcasts, _  = meter.Int64Counter("relay_broadcast_sends", metric.WithDescription("frames fanned out to peers"))
	mSlowKicks, _   = meter.Int64Counter("relay_slow_client_kicks", metric.WithDescription("clients dropped for full send queues"))
	mCompactions, _ = meter.Int64Counter("relay_log_compactions", metric.WithDescription("CRDT log compactions applied"))
)

var bg = context.Background()

func channelName(ch byte) string {
	switch ch {
	case 1:
		return "ctrl"
	case 2:
		return "crdt"
	case 3:
		return "aware"
	case 4:
		return "pty"
	default:
		return "other"
	}
}

func recordFrameIn(ch byte, payloadLen int) {
	attrs := metric.WithAttributes(attribute.String("channel", channelName(ch)))
	mFramesIn.Add(bg, 1, attrs)
	mBytesIn.Add(bg, int64(payloadLen), attrs)
}
