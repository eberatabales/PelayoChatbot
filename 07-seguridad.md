# 07 - Seguridad

## 1. Objetivos

Proteger:

- tokens de Meta;
- credenciales de base de datos;
- archivos Autofact;
- datos de clientes;
- agenda;
- credenciales administrativas.

## 2. Secretos

Nunca versionar:

```text
WHATSAPP_ACCESS_TOKEN
WHATSAPP_APP_SECRET
WHATSAPP_VERIFY_TOKEN
DATABASE_URL
S3_ACCESS_KEY
S3_SECRET_KEY
GOOGLE_CLIENT_SECRET
AI_API_KEY
```

Usar `.env` local y secrets del proveedor en producción.

## 3. Webhook

Validar:

- verify token durante handshake;
- firma de webhook cuando corresponda;
- estructura del payload;
- IDs externos.

## 4. Idempotencia

`external_message_id` UNIQUE.

Los reintentos no deben producir:

- múltiples respuestas;
- múltiples citas;
- múltiples eventos.

## 5. Documentos

Autofact:

- bucket privado;
- no exponer listado de archivos;
- no utilizar URLs públicas permanentes;
- acceso desde backend;
- registrar evento de envío cuando corresponda.

## 6. Panel administrativo

Debe requerir autenticación.

Roles iniciales:

```text
ADMIN
SALES
```

Permisos futuros:

```text
ADMIN:
  todo

SALES:
  vehículos lectura
  documentos lectura
  citas CRUD limitado
  conversaciones
```

## 7. IA

No entregar a IA secretos ni información innecesaria.

No permitir que texto del usuario se convierta directamente en:

- SQL;
- path de archivo;
- ID de documento confiable;
- comando de sistema.

Todas las entidades deben resolverse server-side.

## 8. PII

Datos mínimos:

- número telefónico;
- nombre si se obtiene;
- información de cita.

Aplicar minimización de datos.

## 9. Logs

No registrar:

- tokens;
- secretos;
- PDF completo;
- headers con Authorization.

## 10. Rate limiting

Aplicar a endpoints públicos cuando corresponda.

El webhook debe distinguir tráfico válido de endpoints administrativos.
