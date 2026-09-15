# De Google Sheets a una app con ChatGPT

Ejemplo didáctico de Loopian, generado en una conversación con ChatGPT y probado con una planilla real de una cuenta de demostración. Cada persona puede reproducirlo en sus propias cuentas de Google, GitHub y Streamlit Community Cloud.

**Alcance: preparación administrativa. No emite facturas autorizadas por ARCA.** El PDF es un borrador sin validez fiscal. Gmail conserva un borrador dirigido a tu propia cuenta; el código nunca lo envía. El resumen mensual no es un libro IVA ni una declaración fiscal.

## Caso del ejercicio

Empresa Demo y Cliente Demo, ambos responsables inscriptos, producto local en pesos, cantidad 1, precio **neto** 100000, alícuota expresamente asumida del 21%: neto 100000, IVA 21000, total 121000. La habilitación para factura A común es una premisa del ejercicio, no un resultado de una consulta a ARCA. Los CUIT son sintéticos: validar su dígito verificador no acredita inscripción. No usar los datos del ejemplo para emitir comprobantes.

Este código restringe deliberadamente el caso a estas identidades y condiciones. No es un sistema general de facturación listo para producción.

## Reproducir el proceso

1. Conversá con ChatGPT: explicá la operación, condición de IVA del emisor y receptor, moneda y si el precio incluye IVA. Pedile que pregunte lo que falta antes de programar y que contraste las reglas con documentación oficial vigente. No pegues claves fiscales, certificados ni secretos.
2. Creá una planilla vacía de Google Sheets y una carpeta privada de Drive para los borradores. Copiá sus identificadores desde las direcciones del navegador.
3. Creá tu propio proyecto en Google Apps Script. Pegá el código generado para `Code.gs`. En Configuración del proyecto → Propiedades del script agregá `SHEET_ID` y `DRIVE_FOLDER_ID`.
4. Ejecutá `pruebasLogica` y `pruebasPesos`. Ejecutá `inicializar` una sola vez y revisá los permisos de tu proyecto. Se crea un `API_SECRET` aleatorio. Luego ejecutá `cargarEjemplo` únicamente sobre la hoja vacía.
5. En Implementar → Nueva implementación → App web, ejecutá como propietario y habilitá Cualquiera. El endpoint comprueba `API_SECRET` en cada solicitud; una dirección pública no elimina esa comprobación. Copiá la URL terminada en `/exec`. Guardá el secreto de forma privada.
6. Creá un repositorio propio en GitHub. Usá Add file → Create new file para pegar `app.py` y `requirements.txt` generados por ChatGPT. No incluyas secretos. Conservá también el código de Apps Script para poder revisarlo.
7. En Streamlit Community Cloud conectá ese repositorio, rama `main`, archivo `app.py`. En Advanced settings → Secrets configurá el bloque siguiente con tus valores privados. Publicá la app. Los servicios tienen sus propios límites y condiciones; verificá el plan disponible en tu cuenta.
8. Ingresá en la app y tocá Refrescar desde Sheets. Comprobá neto, IVA y total. Corregí los datos, aprobá la venta, conservá el PDF y creá el borrador de Gmail. Verificá el archivo y la planilla. No hay envío automático.
9. Consultá el resumen por mes y descargá el CSV operativo para revisar con el contador. Compartirlo o enviarlo es una acción posterior.

```toml
APP_PASSWORD = "TU_CONTRASENA_LARGA_UNICA_MINIMO_16_CARACTERES"
GAS_URL = "https://script.google.com/macros/s/TU_IMPLEMENTACION/exec"
GAS_SECRET = "TU_API_SECRET_COMPLETO_DE_APPS_SCRIPT"
SHEET_ID = "TU_IDENTIFICADOR_DE_PLANILLA"
```

Los secretos van exclusivamente en la configuración privada de Streamlit. No se copian al repositorio, al chat ni al video. Apps Script conserva su secreto en Propiedades del script. Las credenciales no se envían al navegador del visitante.

## Datos y pruebas

- La hoja recibe pesos legibles con punto decimal y sin separador de miles: `100000` o `1.50`. El código calcula en centavos enteros.
- Un CUIT inválido, una condición IVA ausente o un ID duplicado bloquean el procesamiento.
- La aprobación corresponde a una versión de los datos. Si cambian, hay que revisarlos otra vez.
- El PDF y el borrador se identifican en la planilla. Repetir una acción consulta lo conservado. Un resultado incierto requiere revisión; no se reintenta automáticamente.
- Después de comenzar a conservar documentos, las correcciones de esa venta quedan bloqueadas. No borrar el historial ni editar manualmente columnas de control.
- Usá un solo proyecto Apps Script como escritor. La demo no contempla administración multiusuario, permisos por rol ni disponibilidad garantizada.

## Qué falta para emitir con ARCA

Este repositorio no implementa WSAA ni WSFEv1. Para completar un sistema fiscal hay que desarrollar y probar la integración, verificar habilitación del emisor, punto de venta compatible, certificado y autorizaciones del ambiente correcto, datos del receptor, tipo y numeración de comprobante, importes e impuestos y tratamiento de respuestas y rechazos. La autorización debe obtenerse realmente y guardarse. Un PDF o un servicio que responde no equivale a un CAE.

Homologación es el ambiente de prueba; sus resultados no autorizan una factura real. La puesta en producción requiere configuración separada y revisión del caso concreto con el profesional responsable. No inferir tipo de comprobante o alícuota sólo por el CUIT.

Fuentes oficiales para continuar:

- [Comprobantes según el régimen](https://www.arca.gob.ar/facturacion/regimen-general/comprobantes.asp)
- [Documentación de factura electrónica y manual vigente](https://www.arca.gob.ar/ws/documentacion/ws-factura-electronica.asp)
- [Autenticación WSAA](https://www.arca.gob.ar/ws/documentacion/wsaa.asp)
- [Certificados](https://www.arca.gob.ar/ws/documentacion/certificados.asp)
- [Conceptos de homologación WSASS](https://www.arca.gob.ar/ws/WSASS/html/conceptos.html)

No aplicar a todos los casos la alícuota del 21% ni simplificar las reglas actuales de exposición de impuestos según la letra del comprobante. Contrastá siempre el caso real y la normativa vigente.
