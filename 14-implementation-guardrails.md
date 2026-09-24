# 14 - Implementation Guardrails

## Objetivo

Evitar que una IA complete vacíos de negocio mediante suposiciones.

## Puede implementarse ahora

### Base
- NestJS
- TypeScript
- Docker
- PostgreSQL
- Prisma
- configuración

### WhatsApp
- webhook
- verificación
- normalización
- adapter
- envío de texto/documento
- idempotencia

### Persistencia
- Customer
- Conversation
- Message

### Inventario MVP
- Vehicle
- repository
- service
- CRUD
- seeds
- search

### Documentos
- VehicleDocument
- storage abstraction
- Autofact
- envío

### Conversation Engine
- state machine
- handoff
- deterministic fallback

## Puede prepararse, pero no cerrarse

### Agenda
Permitido:
- interfaces;
- fake provider;
- appointment repository;
- DTOs;
- state transitions;
- tests parametrizados.

No permitido todavía:
- asumir capacidad 1 global;
- asumir vendedor único;
- asumir que vehicle_id bloquea automáticamente el horario;
- definir duración real sin dato de negocio.

### Panel
Permitido:
- estructura UI;
- authorization abstraction;
- roles.

No permitido:
- escoger proveedor auth.

### IA
Permitido:
- `AIProvider` interface;
- mocks;
- schema placeholder versionado.

No permitido:
- fijar enum final;
- utilizar output no validado;
- ejecutar acciones desde output libre.

## Regla de incertidumbre

Si una feature requiere una decisión marcada como PENDING:

```text
STOP DECISION
→ mantener abstracción
→ documentar supuesto que falta
→ continuar solo con partes independientes
```

No bloquear el proyecto entero por una decisión que afecta únicamente una fase futura.
