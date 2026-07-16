// Package obs wires OpenTelemetry metrics for Atelier services (blueprint
// doc 10 Part A): OTel SDK → Prometheus exporter → /metrics, scraped by the
// dev compose stack. Traces join when the event bus lands (spans pay off at
// cross-service hops, not inside single-process paths).
package obs

import (
	"fmt"
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	otelprom "go.opentelemetry.io/otel/exporters/prometheus"
	"go.opentelemetry.io/otel"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
)

// InitMetrics installs the global OTel MeterProvider backed by a Prometheus
// registry and returns the /metrics handler. Instruments created via
// otel.Meter() before this call still work — the global delegates once the
// provider is installed.
func InitMetrics(serviceName string) (http.Handler, error) {
	registry := prometheus.NewRegistry()
	exporter, err := otelprom.New(otelprom.WithRegisterer(registry))
	if err != nil {
		return nil, fmt.Errorf("obs: prometheus exporter: %w", err)
	}
	// Schemaless so it merges cleanly with resource.Default() regardless of
	// which semconv schema version the SDK ships.
	res, err := resource.Merge(resource.Default(), resource.NewSchemaless(
		semconv.ServiceName(serviceName),
	))
	if err != nil {
		return nil, fmt.Errorf("obs: resource: %w", err)
	}
	provider := sdkmetric.NewMeterProvider(
		sdkmetric.WithReader(exporter),
		sdkmetric.WithResource(res),
	)
	otel.SetMeterProvider(provider)
	return promhttp.HandlerFor(registry, promhttp.HandlerOpts{}), nil
}
