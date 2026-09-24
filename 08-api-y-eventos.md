# 08 - API y eventos

## API interna propuesta

### Vehicles

```text
GET    /vehicles
GET    /vehicles/:id
POST   /vehicles
PATCH  /vehicles/:id
```

### Documents

```text
GET    /vehicles/:id/documents
POST   /vehicles/:id/documents
PATCH  /documents/:id
```

### Appointments

```text
GET    /appointments
GET    /appointments/availability
POST   /appointments
PATCH  /appointments/:id/cancel
```

### Conversations

```text
GET    /conversations
GET    /conversations/:id
PATCH  /conversations/:id/mode
```

### Webhook

```text
GET    /webhooks/whatsapp
POST   /webhooks/whatsapp
```

## DTO conceptual para disponibilidad

```json
{
  "vehicleId": "uuid",
  "date": "2026-09-25"
}
```

Respuesta:

```json
{
  "slots": [
    {
      "startsAt": "2026-09-25T11:00:00-03:00",
      "available": true
    }
  ]
}
```

## DTO conceptual de creación de cita

```json
{
  "customerId": "uuid",
  "vehicleId": "uuid",
  "startsAt": "2026-09-25T15:00:00-03:00"
}
```

## Eventos internos futuros

```text
whatsapp.message.received
customer.created
vehicle.selected
document.sent
appointment.requested
appointment.created
appointment.cancelled
conversation.handoff
```

Estos eventos pueden comenzar como funciones internas y evolucionar a cola/event bus posteriormente.

## Idempotency key

Para citas creadas desde WhatsApp se recomienda asociar:

```text
conversation_id
message_id
```

a la operación causante para reducir duplicados.
