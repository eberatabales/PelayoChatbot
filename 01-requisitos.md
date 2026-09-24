# 01 - Requisitos

## 1. Requisitos funcionales

### RF-01 - Recepción de mensajes
El sistema debe recibir mensajes entrantes desde WhatsApp mediante webhook.

### RF-02 - Deduplicación
Cada mensaje entrante debe identificarse por su ID externo y procesarse una sola vez.

### RF-03 - Registro de cliente
Cuando un número interactúe por primera vez, se debe crear un registro de cliente.

### RF-04 - Conversación
Cada interacción debe asociarse a una conversación activa.

### RF-05 - Identificación de vehículo
El sistema debe permitir identificar un vehículo mediante atributos como:

- marca;
- modelo;
- año;
- color;
- patente;
- ID interno;
- referencia proveniente de un anuncio.

### RF-06 - Desambiguación
Si una búsqueda devuelve varios vehículos, el bot debe solicitar al usuario seleccionar uno.

### RF-07 - Datos reales
La respuesta sobre inventario debe provenir exclusivamente de la base de datos.

### RF-08 - Documento Autofact
Cada vehículo puede tener uno o más documentos asociados.

### RF-09 - Entrega automática
Cuando exista un Autofact activo asociado al vehículo seleccionado, el sistema debe enviarlo por WhatsApp.

### RF-10 - Documento faltante
Si el Autofact no existe, el bot no debe inventarlo ni sustituirlo. Debe informar el problema o derivar a atención humana.

### RF-11 - Oferta de visita
Después de entregar antecedentes, el bot debe ofrecer agendar una visita.

### RF-12 - Disponibilidad
El sistema debe consultar horarios disponibles.

### RF-13 - Reserva
El usuario debe poder seleccionar un horario disponible.

### RF-14 - Revalidación
Antes de crear la reserva se debe validar nuevamente la disponibilidad.

### RF-15 - Persistencia
Toda reserva debe almacenarse en PostgreSQL.

### RF-16 - Confirmación
Después de crear la reserva se debe enviar confirmación al cliente.

### RF-17 - Cancelación
En una fase posterior, el cliente debe poder cancelar una reserva futura.

### RF-18 - Human handoff
El cliente debe poder solicitar hablar con un ejecutivo.

### RF-19 - Modo conversación
La conversación debe poder estar en modo:

- BOT;
- HUMAN.

Cuando esté en modo HUMAN, el bot no debe responder automáticamente salvo acciones explícitamente definidas.

### RF-20 - Historial
Se deben persistir mensajes relevantes y eventos de negocio.

---

## 2. Requisitos no funcionales

### RNF-01 - Seguridad
Tokens y secretos nunca deben almacenarse en el repositorio.

### RNF-02 - Privacidad documental
Los Autofact no deben exponerse mediante URLs públicas permanentes.

### RNF-03 - Idempotencia
El procesamiento de webhooks debe tolerar reintentos.

### RNF-04 - Trazabilidad
Debe ser posible determinar:

- qué mensaje llegó;
- qué vehículo fue seleccionado;
- qué documento fue enviado;
- qué cita fue creada;
- cuándo ocurrió.

### RNF-05 - Mantenibilidad
El backend debe dividirse por dominios.

### RNF-06 - Evolución
El sistema debe permitir agregar nuevas fuentes de inventario o agenda sin reescribir la lógica conversacional.

### RNF-07 - Tiempo de respuesta
El webhook debe responder rápidamente y no permanecer bloqueado por operaciones pesadas.

### RNF-08 - Disponibilidad
Si IA, Calendar o storage fallan, el sistema debe manejar el error sin inventar resultados.

### RNF-09 - Observabilidad
Errores relevantes deben quedar registrados.

### RNF-10 - Testabilidad
La lógica de dominio debe poder probarse sin llamar realmente a WhatsApp, Google Calendar o almacenamiento externo.

---

## 3. Reglas de negocio iniciales

- Solo vehículos con estado `AVAILABLE` deben ofrecerse como disponibles.
- Un vehículo sin Autofact no debe generar un documento ficticio.
- Una cita requiere vehículo, cliente, fecha de inicio y estado.
- Dos reservas no deben ocupar el mismo recurso/horario cuando la capacidad sea 1.
- La disponibilidad debe revalidarse al confirmar.
- El número de WhatsApp es una identidad de contacto, no una autenticación de usuario interno.
- IA no puede insertar datos de negocio directamente.


---

## 4. Requisitos pendientes de parametrización de negocio

### Agenda

Los requisitos RF-12, RF-13, RF-14 y RF-15 definen comportamiento funcional, pero NO definen aún la política real de capacidad.

La implementación definitiva queda bloqueada hasta conocer:

- recurso o recursos que consume una visita;
- capacidad simultánea;
- duración;
- calendario operativo;
- reglas de bloqueo;
- relación con vendedores.

Hasta entonces, las pruebas deben usar una `AvailabilityPolicy` explícitamente provisional.

### Inventario

`VehicleService` será la fuente interna del MVP.

La sincronización con el inventario real de Pelayo queda fuera hasta conocer la fuente existente.

### Autenticación

Los roles ADMIN y SALES son requisitos de autorización.

El proveedor o mecanismo de autenticación queda pendiente de ADR.

### Inteligencia artificial

El contrato definitivo deberá incluir al menos:

```text
Intent enum
Entity schema
confidence
schema_version
validation
UNKNOWN/FALLBACK
```

No se considera cerrado hasta documentarlo en un ADR y en la especificación de integración IA.
