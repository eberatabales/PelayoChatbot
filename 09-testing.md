# 09 - Estrategia de testing

## 1. Prioridad

Las pruebas deben concentrarse primero en lógica que podría provocar errores comerciales.

## 2. Unit tests

### VehicleService

- encuentra vehículo exacto;
- no devuelve vendidos como disponibles;
- maneja múltiples coincidencias.

### DocumentService

- devuelve Autofact activo;
- ignora documentos archivados;
- falla explícitamente cuando no existe.

### AppointmentService

- detecta horario libre;
- detecta solapamiento;
- revalida antes de crear;
- no crea doble reserva;
- cancela únicamente citas válidas.

### ConversationMachine

- transición correcta por estado;
- fallback;
- handoff;
- no permite acción inválida.

## 3. Integration tests

- PostgreSQL real en container;
- Prisma migrations;
- creación de customer/conversation/message;
- unique constraint de message ID;
- creación transaccional de cita.

## 4. Contract tests

Mocks/adapters para:

- WhatsApp;
- Storage;
- Calendar;
- AI.

## 5. Casos críticos E2E

### E2E-01
Consulta vehículo único → Autofact → no agenda.

### E2E-02
Consulta vehículo → Autofact → agenda → confirmación.

### E2E-03
Dos vehículos coincidentes → desambiguación.

### E2E-04
Vehículo sin Autofact → handoff.

### E2E-05
Horario ocupado → alternativas.

### E2E-06
Horario se ocupa entre propuesta y confirmación → no doble reserva.

### E2E-07
Webhook duplicado → un solo procesamiento.

### E2E-08
IA falla → fallback determinista.

## 6. Test data

Nunca usar datos reales de clientes en tests.

Crear fixtures sintéticos.
