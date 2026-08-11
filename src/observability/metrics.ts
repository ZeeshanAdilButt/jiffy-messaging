import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client'

export const register = new Registry()
collectDefaultMetrics({ register })

export const httpRequestsTotal = new Counter({
  name: 'jiffy_messaging_http_requests_total',
  help: 'Total HTTP requests handled',
  labelNames: ['method', 'route', 'status'],
  registers: [register],
})

export const httpRequestDuration = new Histogram({
  name: 'jiffy_messaging_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status'],
  registers: [register],
})

export const websocketConnectionsActive = new Gauge({
  name: 'jiffy_messaging_websocket_connections_active',
  help: 'WebSocket connections currently open on this instance',
  registers: [register],
})

export const messagesPublishedTotal = new Counter({
  name: 'jiffy_messaging_messages_published_total',
  help: 'Total messages published to the message bus',
  registers: [register],
})
