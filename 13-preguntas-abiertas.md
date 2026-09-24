# 13 - Preguntas abiertas y decisiones pendientes

## Clasificación

```text
BLOCKING-S7  → debe resolverse antes de cerrar agenda
BLOCKING-S8  → debe resolverse antes de auth administrativa
BLOCKING-S9  → debe resolverse antes de IA definitiva
NON-BLOCKING → no impide construir el MVP inicial
```

Estas preguntas NO deben ser respondidas por suposición técnica.

Deben validarse con Automóviles Pelayo.

## 1. Inventario — NON-BLOCKING para Sprints 1-6

- ¿Dónde se administra actualmente el inventario?
- ¿Planilla, sistema propio, sitio web, CRM u otro?
- ¿Existe API?
- ¿Cada vehículo tiene ID único?
- ¿La patente puede usarse internamente como identificador?
- ¿Con qué frecuencia cambia el inventario?

## 2. Autofact

Confirmado:
- ya existen descargados;
- hoy se envían manualmente;
- pueden enviarse al cliente por WhatsApp.

Pendiente:
- ¿dónde están almacenados hoy?
- ¿cómo se nombran?
- ¿cómo se relaciona un PDF con un vehículo?
- ¿quién subirá/reemplazará documentos?
- ¿se conservan versiones anteriores?

## 3. Agenda — BLOCKING-S7

- ¿Existe agenda actual?
- ¿Google Calendar?
- ¿Cada vendedor tiene calendario?
- ¿La visita está asociada al vehículo, vendedor o ambos?
- ¿Cuánto dura una visita?
- ¿Horarios de atención?
- ¿Hay almuerzo/bloqueos?
- ¿Cuántas visitas simultáneas se permiten?
- ¿Puede un vehículo tener dos clientes visitándolo en el mismo horario?

## 4. Atención humana

- ¿Quién recibe la conversación derivada?
- ¿Se seguirá usando WhatsApp Business App?
- ¿Existe CRM?
- ¿Cómo se marca una conversación como devuelta al bot?

## 5. WhatsApp Business

- ¿Pelayo ya tiene WhatsApp Business Account?
- ¿El número actual puede migrarse/conectarse a Cloud API?
- ¿Existe Meta Business Manager configurado?
- ¿El número está vinculado a campañas Click-to-WhatsApp?

## 6. Mensajes

Definir tono oficial:

- formal;
- cordial;
- cercano;
- uso de emojis;
- horarios;
- disclaimer documental;
- nombre comercial exacto.

## 7. Datos del cliente

Definir qué datos realmente se necesitan:

- nombre;
- teléfono;
- email;
- RUT;
- solo teléfono para MVP.

Recomendación inicial:
recopilar el mínimo necesario.

## 8. Panel — BLOCKING-S8

Definir usuarios internos:

- administrador;
- vendedor;
- encargado de inventario.

Definir permisos.

## 9. Infraestructura

- hosting disponible;
- dominio;
- presupuesto;
- proveedor cloud;
- backups;
- ambiente staging/production.

## 10. Métricas

Validar cuáles son importantes para Pelayo:

- Autofact enviados;
- tiempo de respuesta;
- citas generadas;
- conversión consulta → cita;
- derivaciones;
- no-show;
- vehículo con más consultas.
