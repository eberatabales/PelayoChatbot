# 11 - Decisiones arquitectónicas

## ADR-001 - Monolito modular

### Decisión
Usar NestJS en un único backend modular.

### No elegido
Microservicios.

### Motivo
Reducir complejidad de desarrollo y despliegue.

---

## ADR-002 - PostgreSQL como fuente de verdad

### Decisión
Persistir inventario, conversaciones, mensajes y reservas en PostgreSQL.

### No elegido
Google Sheets como base principal.

### Motivo
Consistencia, constraints, queries, transacciones y crecimiento.

---

## ADR-003 - Google Calendar no es la base

### Decisión
Calendar es integración, no fuente de verdad.

### Motivo
Una cita pertenece al dominio y necesita relaciones con cliente y vehículo.

---

## ADR-004 - IA limitada a interpretación

### Decisión
IA no ejecuta reglas de negocio.

### Motivo
Evitar alucinaciones en:

- precios;
- inventario;
- documentos;
- citas.

---

## ADR-005 - PDFs fuera de PostgreSQL

### Decisión
Guardar documentos en object storage y solo metadata en DB.

### Motivo
Escalabilidad, backups y desacoplamiento.

---

## ADR-006 - WhatsApp Cloud API oficial

### Decisión
Usar API oficial.

### No elegido
Automatización basada en WhatsApp Web.

### Motivo
Confiabilidad y compatibilidad empresarial.

---

## ADR-007 - Revalidación de agenda

### Decisión
Comprobar disponibilidad al mostrar horario y otra vez al confirmar.

### Motivo
Evitar race conditions y dobles reservas.

---

## ADR-008 - Cola durable en PostgreSQL para MVP y Redis/BullMQ para escalado

### Decisión
Implementar el desacople asíncrono y la cola durable utilizando el motor relacional de PostgreSQL (`inbound_messages` con `claim_token`, estados `RECEIVED -> CLAIMED -> SENDING -> PROCESSED/UNCERTAIN/FAILED`, tabla de intentos `whatsapp_send_attempts` y tabla de eventos `whatsapp_status_events`) sin añadir dependencias de infraestructura como Redis o RabbitMQ en la fase MVP.

### Estado
Aceptado e implementado en Sprint 2.

### Motivo
1. **Simplicidad operativa**: Evitar dependencias externas de infraestructura (Redis, brokers) en la fase inicial, respetando la regla "No sobrearquitecturar" de `AGENTS.md`.
2. **Durabilidad transaccional**: PostgreSQL garantiza transacciones ACID, deduplicación atómica (`ON CONFLICT` o unique constraints), reclamo atómico verificado por `claim_token`, y persistencia inmediata antes de confirmar HTTP 200 a Meta.
3. **Resiliencia ante caídas**: Separar el estado `CLAIMED` del estado `SENDING` permite distinguir fallas antes del despacho a Meta de fallas posteriores, marcando de forma conservadora `UNCERTAIN` sin reenvíos a ciegas.

### Evolución
Migrar a Redis / BullMQ cuando:
- Se requiera procesamiento distribuido a través de múltiples nodos independientes de workers;
- El throughput supere los 100 mensajes por segundo sostenidos;
- Se requieran colas de prioridad avanzada o retrasos arbitrarios complejos.


---

## ADR-009 - Política de agenda pendiente

### Estado
PENDING.

### Decisión actual
Definir interfaces y servicios, pero no fijar todavía el modelo definitivo de capacidad/disponibilidad.

### Motivo
Faltan reglas de negocio sobre recursos, duración y simultaneidad.

---

## ADR-010 - Fuente real de inventario pendiente

### Estado
PENDING.

### Decisión actual
PostgreSQL será la fuente interna del MVP.

No crear integración externa sin conocer el sistema real utilizado por Pelayo.

---

## ADR-011 - Autenticación del panel pendiente

### Estado
PENDING.

### Conocido
Roles iniciales:

```text
ADMIN
SALES
```

### No decidido
- credentials propias;
- Google OAuth;
- Auth0;
- Clerk;
- proveedor corporativo.

Ningún proveedor debe introducirse sin una decisión explícita.

---

## ADR-012 - Contrato de IA pendiente

### Estado
PENDING hasta Sprint 9.

El contrato definitivo debe especificar:

```text
Intent enum
Entity schema
confidence
schema_version
validation
UNKNOWN/FALLBACK
```
