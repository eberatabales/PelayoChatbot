# 06 - Integraciones

## 1. WhatsApp Cloud API

Uso:

- recibir mensajes;
- enviar texto;
- enviar documentos;
- enviar botones;
- recibir status de mensajes;
- recibir información de referral cuando exista.

### Webhook

Endpoints conceptuales:

```text
GET  /webhooks/whatsapp
POST /webhooks/whatsapp
```

GET:
handshake/verificación.

POST:
eventos entrantes.

### Datos mínimos a normalizar

```text
message_id
from
timestamp
type
text
interactive_reply
referral
```

## 2. Object Storage

Los PDFs no se almacenan directamente en la tabla.

Se almacena:

```text
storage_key
filename
mime_type
```

Ejemplo:

```text
vehicles/veh_123/autofact/autofact-2026-09.pdf
```

Bucket privado.

## 3. Google Calendar

Google Calendar no será la fuente de verdad.

Fuente de verdad:

```text
PostgreSQL
```

Calendar actúa como:

- sincronización;
- visualización para vendedores;
- apoyo para disponibilidad externa.

La implementación debe estar abstraída mediante:

```text
CalendarProvider
```

para poder cambiar de proveedor.

## 4. IA

La IA recibe texto y devuelve estructura.

Ejemplo:

Entrada:

> "Quiero ver el Toyota gris mañana tipo cuatro."

Salida:

```json
{
  "intent": "appointment_request",
  "vehicle": {
    "brand": "Toyota",
    "color": "gris"
  },
  "datetime": {
    "relative_date": "tomorrow",
    "time": "16:00"
  }
}
```

La salida debe validarse antes de usarse.

## 5. Meta Ads / Click-to-WhatsApp

Posible evolución.

Si WhatsApp entrega metadata de referral proveniente de un anuncio, se puede mapear:

```text
ad_ref → vehicle_id
```

Esto permitiría que el sistema conozca el vehículo de interés sin preguntarlo nuevamente.

Modelo futuro:

```text
vehicle_ads
id
vehicle_id
platform
external_ad_id
status
```


---

## 6. Fuente externa de inventario

No existe aún una integración aprobada.

Durante el MVP:

```text
PostgreSQL local
→ VehicleRepository
→ VehicleService
```

es suficiente.

Cualquier futuro conector deberá implementar una abstracción equivalente a:

```text
InventoryProvider
```

Ejemplos posibles, no aprobados:
- API externa;
- CRM;
- ERP;
- importador CSV/Excel;
- sincronización con sitio web.

No construir ninguno por suposición.

---

## 7. Contrato futuro de IA

El adaptador de IA deberá devolver una estructura versionada.

Borrador conceptual:

```json
{
  "schema_version": "1.0",
  "intent": "VEHICLE_SEARCH",
  "confidence": 0.93,
  "entities": {
    "brand": "Mazda",
    "model": "3",
    "year": 2021,
    "color": "blanco"
  }
}
```

Debe existir:

- enum cerrado de intents;
- schema validable;
- `UNKNOWN`;
- threshold configurable;
- fallback cuando confidence sea insuficiente;
- rechazo de campos no válidos.

Este contrato es deliberadamente un borrador hasta Sprint 9.
