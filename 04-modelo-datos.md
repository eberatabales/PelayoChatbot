# 04 - Modelo de datos

## ERD inicial

```mermaid
erDiagram
    CUSTOMERS ||--o{ CONVERSATIONS : starts
    CUSTOMERS ||--o{ APPOINTMENTS : books

    VEHICLES ||--o{ VEHICLE_DOCUMENTS : has
    VEHICLES ||--o{ CONVERSATIONS : concerns
    VEHICLES ||--o{ APPOINTMENTS : scheduled_for

    CONVERSATIONS ||--o{ MESSAGES : contains

    USERS ||--o{ AUDIT_LOGS : generates

    CUSTOMERS {
        uuid id PK
        string phone UK
        string name
        datetime created_at
        datetime updated_at
    }

    VEHICLES {
        uuid id PK
        string external_ref
        string brand
        string model
        int year
        string plate
        string color
        int mileage
        decimal price
        string status
        datetime created_at
        datetime updated_at
    }

    VEHICLE_DOCUMENTS {
        uuid id PK
        uuid vehicle_id FK
        string type
        string storage_key
        string filename
        string status
        datetime issued_at
        datetime uploaded_at
    }

    CONVERSATIONS {
        uuid id PK
        uuid customer_id FK
        uuid vehicle_id FK
        string state
        string mode
        datetime started_at
        datetime updated_at
        datetime closed_at
    }

    MESSAGES {
        uuid id PK
        uuid conversation_id FK
        string external_message_id UK
        string direction
        string type
        text content
        json metadata
        datetime created_at
    }

    APPOINTMENTS {
        uuid id PK
        uuid customer_id FK
        uuid vehicle_id FK
        datetime starts_at
        datetime ends_at
        string status
        string source
        string calendar_event_id
        datetime created_at
        datetime updated_at
    }

    USERS {
        uuid id PK
        string email UK
        string name
        string role
        string status
    }

    AUDIT_LOGS {
        uuid id PK
        uuid user_id FK
        string action
        string entity_type
        uuid entity_id
        json payload
        datetime created_at
    }
```

## Estados de VEHICLES

```text
AVAILABLE
RESERVED
SOLD
INACTIVE
```

Solo `AVAILABLE` debe ofrecerse por defecto.

## Tipos de documento

```text
AUTOFACT
REVISION_TECNICA
PADRON
PERMISO_CIRCULACION
MAINTENANCE
OTHER
```

MVP utiliza `AUTOFACT`.

## Estado de documento

```text
ACTIVE
REPLACED
ARCHIVED
```

## Estados de APPOINTMENTS

```text
PENDING
CONFIRMED
CANCELLED
COMPLETED
NO_SHOW
```

## Modos de conversación

```text
BOT
HUMAN
```

## Dirección de mensajes

```text
INBOUND
OUTBOUND
```

## Tipos de mensajes

```text
TEXT
DOCUMENT
INTERACTIVE
IMAGE
SYSTEM
```

## Constraints recomendadas

- `customers.phone` UNIQUE
- `messages.external_message_id` UNIQUE
- `vehicles.plate` UNIQUE cuando exista y sea confiable
- FK obligatorias para documentos
- índices en:
  - vehicles(status)
  - vehicles(brand, model, year)
  - appointments(starts_at, status)
  - conversations(customer_id, state)


---

## Modelo de agenda: estado provisional

La entidad `APPOINTMENTS` actual representa el mínimo necesario para construir el flujo, pero NO modela todavía la capacidad real del negocio.

No asumir que `vehicle_id` por sí solo representa el recurso cuya disponibilidad debe bloquearse.

Una posible evolución futura, NO aprobada todavía, podría incorporar:

```text
RESOURCES
- id
- type
- name
- capacity

APPOINTMENT_RESOURCES
- appointment_id
- resource_id
```

o relaciones explícitas con vendedores/sucursales.

La elección dependerá de las respuestas de negocio de `13-preguntas-abiertas.md`.

Hasta entonces:
- mantener `Appointment` simple;
- encapsular disponibilidad en servicio/policy;
- evitar constraints de capacidad irreversibles.
