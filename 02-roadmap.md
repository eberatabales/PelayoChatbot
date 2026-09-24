# 02 - Roadmap

## Estrategia

Construir primero el camino crítico completo y agregar sofisticación después.

No comenzar por IA.

## Fase 1 - Base técnica

Objetivo:
tener un backend desplegable y con persistencia.

Entregables:

- NestJS;
- TypeScript;
- PostgreSQL;
- Prisma;
- Docker Compose;
- variables de entorno;
- health endpoint;
- migraciones iniciales.

## Fase 2 - WhatsApp mínimo

Objetivo:
recibir y responder mensajes reales.

Entregables:

- verificación webhook;
- POST webhook;
- cliente de WhatsApp Cloud API;
- envío de texto;
- logging inicial.

## Fase 3 - Persistencia conversacional

Entregables:

- customers;
- conversations;
- messages;
- deduplicación;
- estados de conversación.

## Fase 4 - Inventario

Entregables:

- vehicles;
- búsqueda;
- disponibilidad;
- desambiguación básica.

## Fase 5 - Documentos

Entregables:

- vehicle_documents;
- storage privado;
- carga de PDF;
- envío de Autofact.

Primer gran hito:

```text
Consulta vehículo → Autofact automático
```

## Fase 6 - Motor conversacional

Entregables:

- máquina de estados;
- transitions;
- comandos globales;
- fallbacks;
- human handoff.

## Fase 7 - Agenda

Entregables:

- appointments;
- disponibilidad;
- selección;
- revalidación;
- reserva;
- confirmación.

Segundo gran hito:

```text
Consulta → Autofact → Agenda → Reserva
```

## Fase 8 - Panel administrativo

Entregables:

- login interno;
- vehículos;
- documentos;
- citas;
- conversaciones;
- derivaciones.

## Fase 9 - IA

Entregables:

- intent parser;
- entity extraction;
- JSON estructurado;
- thresholds/fallbacks;
- pruebas contra frases reales.

## Fase 10 - Endurecimiento

Entregables:

- Redis;
- BullMQ;
- retries;
- rate limits;
- auditoría;
- backups;
- CI/CD;
- métricas.
