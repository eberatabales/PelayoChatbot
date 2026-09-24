# PelayoBot

Sistema de atención automatizada por WhatsApp para Automóviles Pelayo.

## 1. Visión del proyecto

PelayoBot automatiza una parte crítica del proceso comercial de Automóviles Pelayo:

1. un potencial cliente consulta por un vehículo mediante WhatsApp;
2. el sistema identifica el vehículo solicitado;
3. consulta el inventario real;
4. encuentra el informe Autofact previamente descargado y almacenado por la empresa;
5. envía automáticamente el PDF al cliente;
6. ofrece agendar una visita presencial;
7. consulta disponibilidad;
8. permite seleccionar un horario;
9. crea la cita;
10. confirma la reserva por WhatsApp;
11. deriva a una persona cuando el bot no puede resolver la solicitud.

La automatización NO genera ni compra informes Autofact. Automóviles Pelayo ya dispone de estos archivos y hoy los envía manualmente. PelayoBot automatiza ese proceso.

---

## 2. Problema

Actualmente existe fricción entre el interés inicial del cliente y la visita presencial:

- el cliente consulta por WhatsApp;
- un ejecutivo debe leer el mensaje;
- identificar el vehículo;
- buscar manualmente el Autofact;
- enviar el archivo;
- preguntar si desea visitar el vehículo;
- revisar horarios;
- coordinar una cita;
- confirmar la reserva.

Este flujo depende de disponibilidad humana y puede generar tiempos de espera innecesarios.

---

## 3. Objetivo general

Automatizar la atención inicial de clientes interesados en vehículos mediante WhatsApp, entregando automáticamente documentación asociada al vehículo y permitiendo agendar visitas presenciales de forma segura y trazable.

---

## 4. Objetivos específicos

- Integrar el sistema con WhatsApp Business Platform / Cloud API.
- Identificar el vehículo por el cual consulta un cliente.
- Consultar exclusivamente inventario real.
- Asociar documentos a vehículos.
- Enviar automáticamente el Autofact correcto.
- Registrar clientes, conversaciones y mensajes.
- Gestionar estados conversacionales.
- Consultar disponibilidad para visitas.
- Crear citas evitando dobles reservas.
- Confirmar reservas por WhatsApp.
- Permitir derivación a un ejecutivo humano.
- Mantener trazabilidad de eventos relevantes.
- Incorporar IA solamente como capa de interpretación, nunca como fuente de verdad operacional.

---

## 5. Principio técnico principal

> La IA interpreta; el backend decide.

La IA puede identificar intenciones y extraer entidades desde lenguaje natural.

Ejemplo:

Usuario:

> "Hola, vi un Mazda blanco como del 2021 y quiero saber si todavía lo tienen."

La capa de IA puede devolver:

```json
{
  "intent": "vehicle_search",
  "brand": "Mazda",
  "color": "blanco",
  "year": 2021
}
```

Pero NO puede decidir:

- qué vehículo existe;
- qué precio tiene;
- si está disponible;
- qué Autofact enviar;
- qué horario está disponible;
- si una reserva fue creada;
- qué documento pertenece a cada vehículo.

Todo eso debe resolverse mediante lógica determinista y datos reales.

---

## 6. Alcance del MVP

El MVP debe demostrar de extremo a extremo:

```text
Cliente
  ↓
WhatsApp
  ↓
Identificación del vehículo
  ↓
Consulta al inventario real
  ↓
Envío del Autofact asociado
  ↓
Oferta de visita
  ↓
Consulta de disponibilidad
  ↓
Confirmación
  ↓
Creación de cita
  ↓
Mensaje de confirmación
```

### Incluido en MVP

- recepción de mensajes de WhatsApp;
- respuesta desde backend;
- clientes;
- conversaciones;
- mensajes;
- vehículos;
- Autofact por vehículo;
- envío de PDF;
- estado conversacional;
- disponibilidad;
- citas;
- confirmación;
- deduplicación por message ID;
- human handoff básico.

### Fuera del MVP inicial

- financiamiento;
- pagos;
- tasaciones;
- CRM completo;
- campañas de marketing;
- reservas con abono;
- postventa;
- recomendaciones complejas;
- voz;
- microservicios;
- infraestructura distribuida avanzada.

---

## 7. Stack recomendado

### Backend
- Node.js
- TypeScript
- NestJS

### Base de datos
- PostgreSQL
- Prisma ORM inicialmente

### WhatsApp
- WhatsApp Business Platform / Cloud API oficial de Meta

### Documentos
- almacenamiento privado compatible con S3
- Cloudflare R2, AWS S3 o equivalente

### Agenda
- PostgreSQL como fuente de verdad
- Google Calendar como integración/sincronización opcional

### Frontend administrativo
- Next.js / React
- Tailwind CSS
- shadcn/ui

### Validación
- Zod o DTOs/validation pipes de NestJS

### Infraestructura
- Docker
- Docker Compose
- GitHub Actions posteriormente

### Procesamiento asíncrono
- Redis + BullMQ, incorporado cuando el flujo síncrono básico ya esté validado

---

## 8. Filosofía de arquitectura

Se utilizará un monolito modular.

No comenzar con microservicios.

Dominios principales:

```text
whatsapp
conversations
vehicles
documents
appointments
customers
users
audit
ai
```

La separación debe ser lógica por módulos, sin fragmentar prematuramente el despliegue.

---

## 9. Documentación del proyecto

Para seguir la implementación, consultar el [plan de diez sprints con subtareas](10-sprints.md). Incluye diagnóstico del estado actual, dependencias, checklists, criterios de cierre, demos y decisiones pendientes por etapa.

Consultar:

- `00-resumen-proyecto.md`
- `01-requisitos.md`
- `02-roadmap.md`
- `03-arquitectura.md`
- `04-modelo-datos.md`
- `05-flujos-conversacionales.md`
- `06-integraciones.md`
- `07-seguridad.md`
- `08-api-y-eventos.md`
- `09-testing.md`
- `10-sprints.md`
- `11-decisiones-arquitectonicas.md`
- `13-preguntas-abiertas.md`
- `14-implementation-guardrails.md`
- `AGENTS.md`
- `PROJECT_CONTEXT.md`

---

## 10. Regla de oro para implementación

Antes de escribir una feature:

1. identificar el flujo funcional;
2. identificar la entidad afectada;
3. definir estado inicial y final;
4. definir validaciones;
5. definir errores;
6. definir qué queda persistido;
7. recién después implementar controlador/servicio/repositorio.

PelayoBot debe priorizar confiabilidad sobre respuestas creativas.
