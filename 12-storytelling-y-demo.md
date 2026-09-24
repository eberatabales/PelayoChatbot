# 12 - Storytelling y demo

## Storytelling

### Antes

Un potencial cliente encuentra un vehículo fuera del horario de máxima atención.

Escribe por WhatsApp:

> "Hola, me interesa el Mazda 3 2021."

Actualmente debe esperar a que una persona:

- lea;
- identifique;
- busque antecedentes;
- envíe el Autofact;
- coordine disponibilidad.

### Después

PelayoBot responde inmediatamente.

```text
Cliente
"Hola, me interesa el Mazda 3 2021."
```

```text
PelayoBot
"¡Hola! Encontré el Mazda 3 2021 disponible.
Te adjunto el informe Autofact asociado para que
puedas revisar sus antecedentes."
```

PDF.

Después:

```text
"¿Te gustaría agendar una visita?"
```

Cliente:

```text
"Sí."
```

Sistema:

```text
"Estos horarios están disponibles:
11:00
15:00
17:00"
```

Cliente:

```text
"15:00"
```

Sistema:

```text
"¿Confirmas tu visita a las 15:00?"
```

Cliente:

```text
"Sí."
```

Sistema:

```text
"✅ Tu visita quedó confirmada."
```

## Demo ideal

La demo debe mostrar:

1. mensaje en WhatsApp real;
2. webhook recibido;
3. vehículo encontrado en DB;
4. documento encontrado;
5. PDF recibido;
6. horario consultado;
7. cita creada;
8. reserva visible en panel/DB;
9. confirmación por WhatsApp.

## Métricas futuras

- tiempo medio hasta entrega de Autofact;
- porcentaje de consultas automatizadas;
- citas generadas;
- tasa consulta → cita;
- handoffs;
- errores de documento;
- no-shows.
