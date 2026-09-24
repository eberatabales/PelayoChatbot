# PROJECT_CONTEXT.md

## Propósito

Este documento es la fuente de verdad compacta para cualquier IA o desarrollador que entre al proyecto PelayoBot.

Si existe contradicción entre una suposición de código y este documento, detenerse y revisar la documentación antes de continuar.

## Qué estamos construyendo

PelayoBot es un sistema de automatización comercial por WhatsApp para Automóviles Pelayo.

El flujo principal es:

```text
Cliente consulta un vehículo
→ sistema identifica el vehículo
→ consulta inventario real
→ localiza Autofact previamente descargado
→ envía PDF por WhatsApp
→ pregunta si desea visitar el vehículo
→ consulta disponibilidad
→ usuario selecciona horario
→ sistema revalida disponibilidad
→ crea cita
→ confirma por WhatsApp
```

## Qué NO estamos construyendo inicialmente

No estamos construyendo:

- un CRM completo;
- ecommerce de vehículos;
- financiamiento;
- pagos;
- compra automática de Autofact;
- tasaciones;
- motor de recomendaciones avanzado;
- microservicios;
- un agente autónomo que pueda modificar datos sin reglas.

## Hechos confirmados del negocio

1. Automóviles Pelayo ya descarga Autofact de sus vehículos.
2. Actualmente esos PDF se envían manualmente por WhatsApp.
3. Existe permiso operacional para enviar esos documentos a los clientes.
4. El nuevo sistema debe automatizar ese envío.
5. El objetivo posterior es facilitar el agendamiento de una visita presencial.
6. Si el bot no puede resolver correctamente una situación, debe existir handoff humano.

## Arquitectura

### Backend
NestJS + TypeScript.

### Persistencia
PostgreSQL.

### ORM
Prisma inicialmente.

### Mensajería
WhatsApp Business Platform / Cloud API oficial.

### Archivos
Object storage privado compatible con S3.

### Agenda
PostgreSQL es fuente de verdad.
Google Calendar puede sincronizarse como integración.

### IA
La IA se limita a interpretación de intención y extracción de entidades.

## Regla más importante

> Nunca confiar en la IA para hechos de negocio.

Los siguientes datos siempre salen del backend/DB:

- vehículo;
- disponibilidad;
- precio;
- patente;
- Autofact;
- estado;
- horario;
- cita.

## Arquitectura conversacional

Máquina de estados.

Estados iniciales:

```text
GREETING
IDENTIFYING_VEHICLE
VEHICLE_CLARIFICATION
VEHICLE_SELECTED
DOCUMENT_SENT
OFFERING_APPOINTMENT
ASKING_DATETIME
CONFIRMING_APPOINTMENT
APPOINTMENT_BOOKED
HUMAN_HANDOFF
CLOSED
```

Modo:

```text
BOT
HUMAN
```

## Entidades principales

```text
Customer
Vehicle
VehicleDocument
Conversation
Message
Appointment
User
AuditLog
```

## Restricciones críticas

### Webhook
Debe ser idempotente.

### Messages
`external_message_id` debe ser UNIQUE.

### Documentos
No públicos de forma permanente.

### Appointments
Revalidar disponibilidad justo antes de guardar.

### Human handoff
Si conversación está en HUMAN, el bot no continúa automáticamente.

## Evolución recomendada

```text
1 Base técnica
2 WhatsApp
3 Persistencia
4 Inventario
5 Autofact
6 Conversation Engine
7 Agenda
8 Panel
9 IA
10 Producción / Queue / CI-CD
```

## Cómo debe trabajar una IA desarrolladora

Antes de implementar:

1. revisar estado actual;
2. comparar con documentación;
3. no reescribir lo que funciona;
4. proponer cambios pequeños;
5. mantener separación por dominio;
6. incluir validaciones;
7. incluir errores esperables;
8. incluir tests;
9. explicar decisiones;
10. cuando haya decisiones relevantes, presentar tres alternativas y recomendar una.

## Prioridad del producto

Confiabilidad > creatividad.

Un "no encontré el vehículo" correcto vale más que inventar una respuesta convincente.


## Jerarquía documental

Cuando exista contradicción entre documentos, resolver usando este orden de precedencia:

```text
1. PROJECT_CONTEXT.md
2. 11-decisiones-arquitectonicas.md
3. 01-requisitos.md
4. 03-arquitectura.md
5. 04-modelo-datos.md
6. 05-flujos-conversacionales.md
7. 08-api-y-eventos.md
8. 02-roadmap.md
9. 10-sprints.md
10. 12-storytelling-y-demo.md
```

Los documentos de menor nivel no pueden invalidar una decisión de uno superior.

Cuando una decisión nueva cambie una decisión arquitectónica previa, debe:
1. actualizarse el ADR correspondiente;
2. actualizar PROJECT_CONTEXT si afecta una regla central;
3. actualizar documentos derivados.

## Decisiones aún NO cerradas

Una IA NO debe inventar estas decisiones:

### Agenda
Todavía no está definido:
- si la cita consume disponibilidad del vehículo, vendedor, sucursal, box u otro recurso;
- capacidad simultánea;
- duración estándar;
- horarios operativos;
- reglas de bloqueo.

Hasta resolverlo:
- se pueden implementar interfaces;
- DTOs;
- repositorios;
- modelos provisionales;
- mocks;
- flujo conversacional;
- pruebas con un proveedor fake.

NO debe implementarse como definitiva una política real de disponibilidad.

### Inventario
No está definida la fuente real externa del inventario.

Hasta resolverlo:
- PostgreSQL local es la fuente de verdad del MVP;
- pueden existir seeds y CRUD;
- no inventar integración con CRM, ERP, planilla o API externa.

### Autenticación administrativa
Está definido que existirán roles ADMIN y SALES.
No está elegido el mecanismo de autenticación.

No introducir Clerk, Auth0, Google OAuth, passwords propios u otro proveedor sin una decisión explícita.

### IA
No existe todavía contrato definitivo de intents/entities.
No implementar Sprint 9 sin cerrar su schema versionado.
