# AGENTS.md - Instrucciones para IA desarrolladora

Este archivo define cómo debe razonar y programar cualquier IA que trabaje en PelayoBot.

## 1. Lee antes de modificar

Antes de programar, leer:

1. `README.md`
2. `00-resumen-proyecto.md`
3. `01-requisitos.md`
4. `03-arquitectura.md`
5. `04-modelo-datos.md`
6. `05-flujos-conversacionales.md`
7. `11-decisiones-arquitectonicas.md`

No implementar una feature contradiciendo estos documentos sin explicarlo.

## 2. No sobrearquitecturar

PelayoBot comienza como monolito modular.

No introducir:

- microservicios;
- Kafka;
- Kubernetes;
- CQRS completo;
- event sourcing;

salvo que exista una necesidad demostrada y aprobada.

## 3. La IA no es la fuente de verdad

Nunca permitir que un LLM decida directamente:

- si un vehículo existe;
- si está disponible;
- precio;
- patente;
- archivo Autofact;
- disponibilidad de horario;
- confirmación de reserva.

La IA puede devolver intención y entidades.

Siempre resolver datos mediante servicios de dominio.

## 4. Reglas de WhatsApp

- deduplicar mediante external message ID;
- responder webhook correctamente;
- no loggear tokens;
- separar transport de negocio;
- manejar payloads no-texto;
- soportar reintentos.

## 5. Reglas de documentos

- storage privado;
- nunca hardcodear paths de usuario;
- documento siempre asociado a vehicle ID;
- solo documentos ACTIVE se envían por defecto;
- si no existe Autofact, fallback/handoff.

## 6. Reglas de agenda

- availability check;
- confirmación explícita;
- re-check antes del insert;
- operación transaccional cuando corresponda;
- nunca crear una reserva si ya existe conflicto.

## 7. Arquitectura de código

Preferir:

```text
controller
→ service
→ repository/provider
```

Controladores delgados.

Servicios de dominio con reglas claras.

Adaptadores para proveedores externos.

## 8. Manejo de errores

Errores externos no deben convertirse en datos inventados.

Ejemplos:

Storage caído:
- NO decir que el Autofact fue enviado.

Calendar caído:
- NO confirmar cita.

AI caído:
- usar fallback determinista o derivar.

## 9. Cambios

Antes de hacer un cambio importante:

- explicar qué archivo se modificará;
- qué problema resuelve;
- impacto;
- pruebas necesarias.

## 10. Tres opciones técnicas

Cuando exista más de una solución relevante:

1. presentar tres alternativas;
2. explicar ventajas;
3. explicar riesgos;
4. recomendar una;
5. preferir eficiencia y mantenibilidad.

## 11. Commits

Commits pequeños y descriptivos.

Ejemplos:

```text
feat(whatsapp): add webhook verification
feat(vehicles): add vehicle search service
feat(documents): send active autofact via whatsapp
feat(appointments): prevent overlapping bookings
test(conversations): cover vehicle clarification flow
```

Evitar:

```text
update
changes
fix stuff
final
```

## 12. Definition of Done

Una feature no está lista solo porque compile.

Debe incluir cuando corresponda:

- validación;
- error handling;
- persistencia;
- tests;
- documentación;
- demo reproducible.


## 13. Límites de autonomía

La IA puede implementar autónomamente, conforme a la documentación:

```text
Sprint 1
Sprint 2
Sprint 3
Sprint 4
Sprint 5
gran parte de Sprint 6
```

La IA debe detener decisiones definitivas en:

### Sprint 7 - Agenda
Puede crear arquitectura, interfaces, mocks y flujo.
No fijar política de capacidad hasta resolver ADR-009.

### Sprint 8 - Auth
No elegir proveedor de autenticación hasta resolver ADR-011.

### Sprint 9 - IA
No cerrar implementación del parser hasta resolver ADR-012.

## 14. Jerarquía documental

Usar este orden:

```text
PROJECT_CONTEXT
→ ADR
→ requisitos
→ arquitectura/modelo
→ flujos/API
→ roadmap/sprints
→ storytelling
```

En caso de conflicto, gana el documento situado más arriba.

## 15. Webhook

La IA debe distinguir:

### MVP ligero
Puede procesar sin queue solo operaciones rápidas y confiables.

### Arquitectura objetivo
Debe seguir:

```text
validate
→ dedupe
→ persist
→ queue
→ 200
→ async processing
```

No mantener el request abierto esperando operaciones potencialmente lentas.
