/**
 * Demo didáctica: Sheets real + PDF de borrador + borrador Gmail.
 * No consulta padrones, no llama a ARCA y no envía correos.
 * Un solo proyecto Apps Script debe escribir estas pestañas.
 */
const ENTRADAS = [
  'id', 'fecha', 'emisor', 'emisor_cuit', 'emisor_iva',
  'cliente', 'cliente_cuit', 'cliente_iva', 'concepto', 'cantidad',
  'precio_neto_centavos', 'alicuota', 'moneda', 'operacion', 'habilitacion'
];
const SALIDAS = [
  'neto_centavos', 'iva_centavos', 'total_centavos', 'estado_revision',
  'resultado_fiscal', 'estado_pdf', 'pdf_id', 'pdf_url',
  'estado_correo', 'borrador_id', 'huella_actual', 'huella_aprobada', 'errores'
];
const CABECERA = ['uid'].concat(
  ENTRADAS.map(k =>
    k === 'precio_neto_centavos' ? 'precio_neto_pesos' : k
  ),
  SALIDAS.map(k => k.replace(/_centavos$/, '_pesos'))
);
const AUDITORIA = ['fecha', 'uid', 'evento', 'registro_json'];
const COPIAR = x => JSON.parse(JSON.stringify(x));

function fallo_(codigo, mensaje) {
  const e = new Error(mensaje); e.codigo = codigo; throw e;
}
function exigir_(ok, codigo, mensaje) {
  if (!ok) fallo_(codigo, mensaje);
}
function propiedades_() {
  return PropertiesService.getScriptProperties();
}
function entorno_() {
  const p = propiedades_();
  const id = p.getProperty('SHEET_ID');
  const carpeta = p.getProperty('DRIVE_FOLDER_ID');
  exigir_(id && carpeta, 'CONFIGURACION',
    'Faltan SHEET_ID o DRIVE_FOLDER_ID.');
  return {
    libro: SpreadsheetApp.openById(id),
    carpeta: carpeta
  };
}
function bloqueo_(fn) {
  const lock = LockService.getScriptLock();
  exigir_(lock.tryLock(20000), 'OCUPADO',
    'Hay otra operación. Volvé a consultar.');
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}
function json_(x) {
  return ContentService.createTextOutput(JSON.stringify(x))
    .setMimeType(ContentService.MimeType.JSON);
}
function sha_(texto) {
  return Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    texto,
    Utilities.Charset.UTF_8
  ).map(b =>
    ('0' + ((b + 256) % 256).toString(16)).slice(-2)
  ).join('');
}
function autenticar_(recibido) {
  const real = propiedades_().getProperty('API_SECRET') || '';
  exigir_(
    real.length >= 64 &&
    typeof recibido === 'string' &&
    recibido.length <= 256,
    'NO_AUTORIZADO',
    'Solicitud no autorizada.'
  );
  const a = sha_(real), b = sha_(recibido);
  let diferencia = 0;
  for (let i = 0; i < a.length; i++) {
    diferencia |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  exigir_(diferencia === 0, 'NO_AUTORIZADO',
    'Solicitud no autorizada.');
}
function doGet() {
  return json_({
    ok: false,
    codigo: 'SOLO_POST',
    mensaje: 'Usá POST autenticado.'
  });
}
function doPost(e) {
  try {
    exigir_(
      e && !e.queryString && e.postData &&
      e.postData.contents.length <= 50000,
      'SOLICITUD_INVALIDA',
      'Usá JSON en el cuerpo, sin parámetros en la URL.'
    );
    const q = JSON.parse(e.postData.contents);
    autenticar_(q.secreto);
    delete q.secreto;
    return json_({
      ok: true,
      datos: bloqueo_(() => ejecutar_(q))
    });
  } catch (e) {
    // Nunca devolver excepciones de Google, solicitudes o secretos.
    return json_({
      ok: false,
      codigo: e.codigo || 'ERROR_INTERNO',
      mensaje: e.codigo ? e.message :
        'No se pudo confirmar la operación. Consultá listar antes de repetir.'
    });
  }
}

// Funciones para ejecutar manualmente desde el editor.
function inicializar() {
  return bloqueo_(() => {
    const c = entorno_();
    [
      ['Ventas', CABECERA],
      ['Historial', AUDITORIA]
    ].forEach(par => {
      let h = c.libro.getSheetByName(par[0]);
      if (!h) h = c.libro.insertSheet(par[0]);

      if (h.getMaxColumns() < par[1].length) {
        h.insertColumnsAfter(
          h.getMaxColumns(),
          par[1].length - h.getMaxColumns()
        );
      }

      if (h.getLastRow() === 0) {
        h.getRange(1, 1, h.getMaxRows(), par[1].length)
          .setNumberFormat('@');
        h.getRange(1, 1, 1, par[1].length).setValues([par[1]]);
        h.setFrozenRows(1);
      }
      comprobarCabecera_(h, par[1]);
    });

    // Comprueba acceso. No cambia permisos ni comparte la carpeta.
    DriveApp.getFolderById(c.carpeta).getName();

    if (!propiedades_().getProperty('API_SECRET')) {
      propiedades_().setProperty(
        'API_SECRET',
        (
          Utilities.getUuid() +
          Utilities.getUuid() +
          Utilities.getUuid()
        ).replace(/-/g, '')
      );
    }
    return {
      estado: 'Inicializado. Revisá API_SECRET en Propiedades del script.'
    };
  });
}
function comprobarCabecera_(h, nombres) {
  exigir_(
    h &&
    h.getLastColumn() === nombres.length &&
    JSON.stringify(
      h.getRange(1, 1, 1, nombres.length).getValues()[0]
    ) === JSON.stringify(nombres),
    'ESQUEMA',
    'Pestaña ausente o encabezados incompatibles. No se borraron datos.'
  );
}
function ejemplo_() {
  return {
    id: 'DEMO-001',
    fecha: '2026-09-15',
    emisor: 'Empresa Demo',
    emisor_cuit: '30000000007',
    emisor_iva: 'RI',
    cliente: 'Cliente Demo',
    cliente_cuit: '20000000001',
    cliente_iva: 'RI',
    concepto: 'Producto de ejemplo',
    cantidad: '1',
    precio_neto_centavos: '10000000',
    alicuota: '21',
    moneda: 'ARS',
    operacion: 'PRODUCTOS_LOCALES',
    habilitacion: 'A_COMUN_ASUMIDA'
  };
}
function cargarEjemplo() {
  return bloqueo_(() => {
    const c = cargar_();
    exigir_(
      c.hoja.getLastRow() === 1 &&
      c.historial.getLastRow() === 1,
      'NO_VACIA',
      'El ejemplo solo se carga con Ventas e Historial vacíos.'
    );

    c.hoja.getRange(2, 1, 1, ENTRADAS.length + 1)
      .setNumberFormat('@')
      .setValues([[
        Utilities.getUuid(),
        ...datosParaHoja_(ejemplo_())
      ]]);

    SpreadsheetApp.flush();
    return listar_(cargar_());
  });
}

// Lógica pura: no depende de Google.
function cuitValido_(valor) {
  const s = String(valor);
  if (!/^\d{11}$/.test(s)) return false;
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  let suma = 0;
  for (let i = 0; i < 10; i++) {
    suma += Number(s[i]) * pesos[i];
  }
  const resto = 11 - suma % 11;
  return resto !== 10 &&
    Number(s[10]) === (resto === 11 ? 0 : resto);
}
function entero_(x) {
  return /^\d+$/.test(String(x)) &&
    Number.isSafeInteger(Number(x));
}
function calcular_(cantidad, precio) {
  if (String(precio).startsWith('PESOS_INVALIDOS:')) {
    fallo_(
      'IMPORTE',
      'Precio neto en Sheets inválido: usá 100000 o 1.50, sin $ ni separadores de miles.'
    );
  }

  exigir_(
    entero_(cantidad) && entero_(precio) &&
    Number(cantidad) > 0 && Number(precio) > 0,
    'IMPORTE',
    'Cantidad y precio deben ser enteros positivos; la API expresa el precio en centavos.'
  );

  const neto = Number(cantidad) * Number(precio);
  exigir_(
    Number.isSafeInteger(neto) &&
    Number.isSafeInteger(neto * 21 + 50),
    'IMPORTE',
    'Importe fuera del límite de cálculo seguro.'
  );

  const iva = Math.floor((neto * 21 + 50) / 100);
  return {
    neto_centavos: neto,
    iva_centavos: iva,
    total_centavos: neto + iva
  };
}
function textoSeguro_(valor) {
  const s = String(valor);
  return s.length <= 200 &&
    !/[\u0000-\u001f\u007f]/.test(s) &&
    !/^\s*[=+\-@']/.test(s);
}
function validar_(d, ids) {
  const errores = [];
  ENTRADAS.forEach(k => {
    if (!textoSeguro_(d[k] === undefined ? '' : d[k])) {
      errores.push(k + ': texto no permitido.');
    }
  });

  if (!/^[A-Za-z0-9_-]{1,50}$/.test(d.id || '')) {
    errores.push('ID inválido.');
  }
  if (ids.filter(id => id === d.id).length > 1) {
    errores.push('ID duplicado.');
  }

  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(d.fecha || '') ||
    !Number.isFinite(Date.parse(d.fecha + 'T12:00:00Z')) ||
    new Date(d.fecha + 'T12:00:00Z').toISOString().slice(0, 10) !== d.fecha
  ) {
    errores.push('Fecha inválida: usá AAAA-MM-DD.');
  }

  ['emisor', 'cliente'].forEach(p => {
    if (!cuitValido_(d[p + '_cuit'])) {
      errores.push('CUIT ' + p + ' inválido.');
    }
    if (!d[p + '_iva']) {
      errores.push('Falta condición IVA del ' + p + '.');
    } else if (d[p + '_iva'] !== 'RI') {
      errores.push('Fuera de alcance: condición IVA distinta de RI.');
    }
  });

  if (
    d.emisor !== 'Empresa Demo' ||
    d.emisor_cuit !== '30000000007' ||
    d.cliente !== 'Cliente Demo' ||
    d.cliente_cuit !== '20000000001'
  ) {
    errores.push(
      'Fuera de alcance: solo Empresa Demo y Cliente Demo con sus CUIT sintéticos.'
    );
  }

  if (
    d.moneda !== 'ARS' ||
    d.operacion !== 'PRODUCTOS_LOCALES' ||
    d.habilitacion !== 'A_COMUN_ASUMIDA' ||
    String(d.alicuota) !== '21'
  ) {
    errores.push(
      'Fuera de alcance: productos locales, ARS, 21 % y A común asumida.'
    );
  }
  if (!String(d.concepto || '').trim()) {
    errores.push('Falta el concepto.');
  }

  let importes = null;
  try {
    importes = calcular_(d.cantidad, d.precio_neto_centavos);
  } catch (e) {
    errores.push(e.message);
  }
  return {
    errores: errores,
    importes: errores.length ? null : importes
  };
}
function datos_(valores) {
  const d = {};
  ENTRADAS.forEach((k, i) => {
    d[k] = String(
      valores[i] === undefined ? '' : valores[i]
    ).trim();
  });
  return d;
}
function huella_(r) {
  return sha_(JSON.stringify([1, r.uid, r.d, r.formulas]));
}
function nuevo_(r) {
  return {
    uid: r.uid,
    datos: COPIAR(r.d),
    aprobada: '',
    aprobada_el: '',
    pdf: { estado: 'PENDIENTE', id: '' },
    correo: { estado: 'PENDIENTE', id: '' }
  };
}
function iniciado_(s) {
  return s && (
    s.pdf.estado !== 'PENDIENTE' ||
    s.correo.estado !== 'PENDIENTE'
  );
}

// Historial es el registro durable; las salidas de Ventas son su vista.
function cargar_() {
  const c = entorno_();
  c.hoja = c.libro.getSheetByName('Ventas');
  c.historial = c.libro.getSheetByName('Historial');
  comprobarCabecera_(c.hoja, CABECERA);
  comprobarCabecera_(c.historial, AUDITORIA);
  c.estados = Object.create(null);
  c.filas = [];

  c.historial.getDataRange().getValues().slice(1).forEach(e => {
    const s = JSON.parse(e[3]);
    exigir_(s.uid === e[1], 'HISTORIAL',
      'Historial inconsistente; requiere revisión.');
    c.estados[s.uid] = s;
  });

  if (c.hoja.getLastRow() > 1) {
    const rango = c.hoja.getRange(
      2, 1, c.hoja.getLastRow() - 1, ENTRADAS.length + 1
    );
    const formulas = rango.getFormulas();
    const vistos = new Set();

    // Validar lo visible, sin reinterpretar comas según la región.
    rango.getDisplayValues().forEach((v, i) => {
      if (v.every(x => x === '')) return;

      exigir_(!formulas[i][0], 'UID',
        'La columna uid no admite fórmulas.');

      let uid = v[0];
      if (!uid) {
        uid = Utilities.getUuid();
        c.hoja.getRange(i + 2, 1)
          .setNumberFormat('@')
          .setValue(uid);
      }

      exigir_(
        /^[a-f0-9-]{36}$/i.test(uid) && !vistos.has(uid),
        'UID',
        'uid alterado o duplicado: restaurá la clave original.'
      );
      vistos.add(uid);

      c.filas.push({
        n: i + 2,
        uid: uid,
        d: datosDesdeHoja_(v.slice(1)),
        formulas: formulas[i].slice(1).map(Boolean)
      });
    });
  }

  c.filas.forEach(r => {
    const s = c.estados[r.uid];
    if (s && s.edicion) aplicarEdicion_(c, r, s);
  });
  return c;
}
function registrar_(c, s, evento) {
  const copia = COPIAR(s);
  c.historial.appendRow([
    new Date().toISOString(),
    s.uid,
    evento,
    JSON.stringify(copia)
  ]);

  // Si no confirma, no empezar un efecto externo.
  SpreadsheetApp.flush();
  c.estados[s.uid] = copia;
}
function fila_(c, uid) {
  const r = c.filas.find(x => x.uid === uid);
  exigir_(r, 'NO_ENCONTRADA',
    'Venta no encontrada. Consultá listar.');
  return r;
}
function evaluar_(c, r) {
  const v = validar_(r.d, c.filas.map(x => x.d.id));
  if (r.formulas.some(Boolean)) {
    v.errores.push(
      'No se aceptan fórmulas en los datos de entrada.'
    );
  }

  Object.keys(c.estados).forEach(uid => {
    const s = c.estados[uid];
    if (
      uid !== r.uid &&
      iniciado_(s) &&
      s.datos.id === r.d.id
    ) {
      v.errores.push(
        'ID reservado por otra venta con una operación iniciada.'
      );
    }
  });

  if (v.errores.length) v.importes = null;
  return v;
}
function vista_(c, r) {
  const s = c.estados[r.uid] || nuevo_(r);
  const v = evaluar_(c, r);
  const h = huella_(r);

  return {
    uid: r.uid,
    datos: r.d,
    importes: v.importes,
    errores: v.errores,
    huella: h,
    huella_aprobada: s.aprobada,
    aprobada_el: s.aprobada_el,
    estado_revision: v.errores.length ? 'ERROR' :
      s.aprobada ?
        (s.aprobada === h ? 'APROBADA' : 'MODIFICADA') :
        'PENDIENTE',
    resultado_fiscal: 'NO_SOLICITADO_DEMO',
    pdf: s.pdf,
    correo: s.correo
  };
}
function listar_(c) {
  c = cargar_();

  const ventas = c.filas.map(r => {
    const v = vista_(c, r);
    const m = v.importes;

    // Solo presentación en Sheets.
    // Los cálculos nunca toman estas salidas como fuente.
    const salida = [
      m ? Number(centavosAPesosTexto_(m.neto_centavos)) : '',
      m ? Number(centavosAPesosTexto_(m.iva_centavos)) : '',
      m ? Number(centavosAPesosTexto_(m.total_centavos)) : '',
      v.estado_revision,
      v.resultado_fiscal,
      v.pdf.estado,
      v.pdf.id,
      v.pdf.id
        ? 'https://drive.google.com/file/d/' + v.pdf.id + '/view'
        : '',
      v.correo.estado,
      v.correo.id,
      v.huella,
      v.huella_aprobada,
      v.errores.join(' | ')
    ];

    const inicio = ENTRADAS.length + 2;
    c.hoja.getRange(r.n, inicio, 1, SALIDAS.length)
      .setValues([salida]);
    c.hoja.getRange(r.n, inicio, 1, 3)
      .setNumberFormat('"$" #,##0.00');

    return v;
  });

  SpreadsheetApp.flush();
  return {
    ventas: ventas,
    ausentes: Object.keys(c.estados)
      .filter(uid => !c.filas.some(r => r.uid === uid))
      .map(uid => c.estados[uid])
  };
}
function exigirVersion_(r, q) {
  exigir_(
    typeof q.huella === 'string' &&
    q.huella === huella_(r),
    'VERSION_CAMBIO',
    'Los datos cambiaron. Leé nuevamente y revisá la venta.'
  );
}
function exigirAprobada_(c, r) {
  const s = c.estados[r.uid];
  const v = evaluar_(c, r);
  exigir_(!v.errores.length, 'VALIDACION', v.errores.join(' '));
  exigir_(
    s && s.aprobada === huella_(r),
    'NO_APROBADA',
    'Aprobá la versión actual antes de continuar.'
  );
  return COPIAR(s);
}
function aplicarEdicion_(c, r, s) {
  const destino = {
    uid: r.uid,
    d: datosDesdeHoja_(datosParaHoja_(s.edicion.datos)),
    formulas: ENTRADAS.map(() => false)
  };
  const h = huella_(r);

  exigir_(
    h === s.edicion.antes || h === huella_(destino),
    'EDICION_INCIERTA',
    'Edición interrumpida y datos modificados manualmente. Revisá Historial antes de continuar.'
  );

  if (h !== huella_(destino)) {
    c.hoja.getRange(r.n, 2, 1, ENTRADAS.length)
      .setNumberFormat('@')
      .setValues([datosParaHoja_(destino.d)]);
    SpreadsheetApp.flush();
  }

  r.d = COPIAR(destino.d);
  r.formulas = destino.formulas;

  const terminado = COPIAR(s);
  terminado.datos = COPIAR(destino.d);
  delete terminado.edicion;
  registrar_(c, terminado, 'EDICION_CONFIRMADA');
}
function actualizar_(c, r, q) {
  exigirVersion_(r, q);
  exigir_(
    !iniciado_(c.estados[r.uid]),
    'BLOQUEADA',
    'No se edita una venta con PDF o correo iniciado, conservado o incierto.'
  );
  exigir_(
    q.datos &&
    Object.keys(q.datos).every(k => ENTRADAS.includes(k)),
    'CAMPOS',
    'Solo se pueden editar campos de entrada conocidos.'
  );

  const d = datos_(ENTRADAS.map(k =>
    Object.prototype.hasOwnProperty.call(q.datos, k) ?
      q.datos[k] : r.d[k]
  ));
  const temporal = {
    uid: r.uid,
    d: d,
    formulas: ENTRADAS.map(() => false)
  };
  const reemplazo = Object.assign({}, c, {
    filas: c.filas.map(x => x.uid === r.uid ? temporal : x)
  });
  const v = evaluar_(reemplazo, temporal);
  exigir_(!v.errores.length, 'VALIDACION', v.errores.join(' '));

  // Ambas versiones quedan guardadas antes de cambiar las celdas.
  const s = nuevo_(temporal);
  s.edicion = {
    antes: huella_(r),
    anteriores: r.d,
    datos: d
  };
  registrar_(c, s, 'EDICION_SOLICITADA');
  aplicarEdicion_(c, r, s);
}
function aprobar_(c, r, q) {
  exigirVersion_(r, q);
  const v = evaluar_(c, r);
  exigir_(!v.errores.length, 'VALIDACION', v.errores.join(' '));

  const previo = c.estados[r.uid];
  if (previo && previo.aprobada === huella_(r)) return;

  exigir_(!iniciado_(previo), 'BLOQUEADA',
    'Hay una operación iniciada; revisala.');

  const s = nuevo_(r);
  s.aprobada = huella_(r);
  s.aprobada_el = new Date().toISOString();
  registrar_(c, s, 'APROBADA_POR_OPERADOR_API');
}

// Todo texto variable se escapa antes de incorporarlo al HTML.
function escapar_(s) {
  return String(s).replace(/[&<>"']/g, x => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[x]);
}
function pesos_(c) {
  return '$ ' +
    Math.floor(c / 100).toLocaleString('es-AR') +
    ',' + ('0' + c % 100).slice(-2);
}
function html_(s) {
  const d = s.datos;
  const m = calcular_(d.cantidad, d.precio_neto_centavos);
  const e = escapar_;

  return '<html><head><meta charset="UTF-8"><style>' +
    '@page{size:A4;margin:22mm}body{font:12pt Arial;color:#111}' +
    '.aviso{border:4px solid #a00;padding:14px;color:#a00;' +
    'font-size:21pt;font-weight:bold}' +
    'table{width:100%;border-collapse:collapse}' +
    'td,th{padding:9px;border-bottom:1px solid #ccc}' +
    '</style></head><body>' +
    '<div class="aviso">BORRADOR — SIN VALIDEZ FISCAL</div>' +
    '<h2>Ejemplo didáctico de factura A</h2>' +
    '<p>Referencia interna: ' + e(d.id) +
    '<br>Fecha de la venta: ' + e(d.fecha) + '</p>' +
    '<p><b>Emisor:</b> Empresa Demo' +
    '<br>CUIT sintético: 30000000007' +
    '<br>Condición IVA asumida: Responsable inscripto</p>' +
    '<p><b>Receptor:</b> Cliente Demo' +
    '<br>CUIT sintético: 20000000001' +
    '<br>Condición IVA asumida: Responsable inscripto</p>' +
    '<table><tr><th>Producto</th><th>Cantidad</th>' +
    '<th>Precio neto unitario</th></tr>' +
    '<tr><td>' + e(d.concepto) +
    '</td><td>' + e(d.cantidad) +
    '</td><td>' + pesos_(Number(d.precio_neto_centavos)) +
    '</td></tr></table>' +
    '<p>Neto gravado: <b>' + pesos_(m.neto_centavos) + '</b></p>' +
    '<p>IVA 21 %: <b>' + pesos_(m.iva_centavos) + '</b></p>' +
    '<p>Total ARS: <b>' + pesos_(m.total_centavos) + '</b></p>' +
    '<p>Producto local supuesto gravado al 21 %. ' +
    'Habilitación A común asumida exclusivamente para este ejercicio. ' +
    'Sin otros cargos ni regímenes.</p>' +
    '<p>Los CUIT se validaron solo localmente. ' +
    'No acredita inscripción fiscal. ' +
    'No se solicitó autorización a ARCA. ' +
    'No tiene numeración fiscal ni CAE.</p>' +
    '<p>Identificador de control: ' + e(s.uid) +
    '<br>Huella: ' + e(s.aprobada) + '</p>' +
    '<div class="aviso">BORRADOR — SIN VALIDEZ FISCAL</div>' +
    '</body></html>';
}
function archivo_(s) {
  const f = DriveApp.getFileById(s.pdf.id);
  const padres = f.getParents();
  let pertenece = false;
  while (padres.hasNext()) {
    if (padres.next().getId() === s.pdf.carpeta) pertenece = true;
  }

  exigir_(
    !f.isTrashed() &&
    pertenece &&
    f.getName() === s.pdf.nombre &&
    f.getMimeType() === MimeType.PDF,
    'REVISAR_PDF',
    'El PDF conservado no está disponible o cambió. No se creará otro automáticamente.'
  );
  return f;
}
function crearArtefacto_(c, r, tipo) {
  let s = exigirAprobada_(c, r);
  const o = s[tipo];

  if (o.estado === 'LISTO') {
    if (tipo === 'pdf') {
      archivo_(s);
    } else {
      exigir_(
        GmailApp.getDraft(o.id).getMessage().getSubject() === o.asunto,
        'REVISAR_CORREO',
        'El borrador cambió; revisalo en Gmail.'
      );
    }
    return;
  }

  exigir_(
    o.estado === 'PENDIENTE',
    'REVISION_REQUERIDA',
    'Operación iniciada o incierta. Usá revisar_operacion; no se repetirá la creación.'
  );

  let blob, destinatario;
  const marca = s.uid + '-' + s.aprobada.slice(0, 16);

  if (tipo === 'pdf') {
    o.nombre = 'BORRADOR-' + marca + '.pdf';
    o.carpeta = c.carpeta;
    blob = Utilities.newBlob(
      html_(s), MimeType.HTML, 'borrador.html'
    ).getAs(MimeType.PDF).setName(o.nombre);
  } else {
    exigir_(s.pdf.estado === 'LISTO', 'PDF_PENDIENTE',
      'Primero conservá el PDF.');
    blob = archivo_(s).getBlob();
    destinatario = Session.getEffectiveUser().getEmail();
    exigir_(destinatario, 'CUENTA',
      'No se pudo identificar la cuenta de demostración.');
    o.asunto = '[DEMO ' + marca + '] Borrador sin validez fiscal';
  }

  const reciente = cargar_();
  const actual = exigirAprobada_(reciente, fila_(reciente, r.uid));
  exigir_(
    actual.aprobada === s.aprobada,
    'VERSION_CAMBIO',
    'La aprobación cambió. Volvé a revisar.'
  );

  // Confirmar este registro ANTES de crear un objeto externo.
  o.estado = 'EN_CURSO';
  o.inicio = new Date().toISOString();
  registrar_(c, s, tipo.toUpperCase() + '_INICIADO');

  try {
    if (tipo === 'pdf') {
      o.id = DriveApp.getFolderById(o.carpeta)
        .createFile(blob).getId();
    } else {
      o.id = GmailApp.createDraft(
        destinatario,
        o.asunto,
        'Ejercicio con datos ficticios. BORRADOR — SIN VALIDEZ FISCAL.\n' +
        'Venta ' + s.datos.id + '. No se solicitó autorización a ARCA.\n' +
        'Este correo queda como borrador y no fue enviado.',
        { attachments: [blob] }
      ).getId();
    }
    o.estado = 'LISTO';
    registrar_(c, s, tipo.toUpperCase() + '_CONSERVADO');
  } catch (e) {
    o.estado = 'INCIERTO';
    try {
      registrar_(c, s, tipo.toUpperCase() + '_INCIERTO');
    } catch (ignorado) {
      // El registro EN_CURSO previo también bloquea otra creación.
    }
    fallo_(
      'INCIERTO',
      'No se pudo confirmar el resultado. Revisá la operación antes de continuar.'
    );
  }
}
function candidatos_(s, tipo) {
  const o = s[tipo];
  const encontrados = [];

  if (tipo === 'pdf' && o.nombre && o.carpeta) {
    const it = DriveApp.getFolderById(o.carpeta)
      .getFilesByName(o.nombre);
    while (it.hasNext()) {
      const f = it.next();
      if (!f.isTrashed() && f.getMimeType() === MimeType.PDF) {
        encontrados.push({
          id: f.getId(),
          nombre: f.getName(),
          url: f.getUrl()
        });
      }
    }
  }

  if (tipo === 'correo' && o.asunto) {
    GmailApp.getDrafts().forEach(d => {
      if (d.getMessage().getSubject() === o.asunto) {
        encontrados.push({
          id: d.getId(),
          asunto: o.asunto
        });
      }
    });
  }
  return encontrados;
}
function revisarOperacion_(c, r, q) {
  exigir_(['pdf', 'correo'].includes(q.tipo), 'TIPO',
    'Usá pdf o correo.');
  const s = c.estados[r.uid];
  exigir_(
    s && s[q.tipo].estado !== 'PENDIENTE',
    'SIN_INTENTO',
    'No hay intento registrado.'
  );
  return {
    estado: s[q.tipo],
    datos_aprobados: s.datos,
    candidatos: candidatos_(s, q.tipo),
    aviso: 'Revisá el contenido. Cero coincidencias no demuestra que no se haya creado.'
  };
}
function recuperar_(c, r, q) {
  const revision = revisarOperacion_(c, r, q);
  const s = COPIAR(c.estados[r.uid]);

  exigir_(
    q.confirmacion === 'REVISE_EL_DOCUMENTO',
    'CONFIRMACION',
    'Revisá el objeto antes de vincular su ID.'
  );
  exigir_(
    revision.candidatos.some(x => x.id === q.id),
    'NO_COINCIDE',
    'El objeto no coincide con la referencia de este intento.'
  );
  exigir_(
    !s[q.tipo].id || s[q.tipo].id === q.id,
    'ID_CONSERVADO',
    'No se reemplaza un ID ya conservado.'
  );

  s[q.tipo].id = q.id;
  s[q.tipo].estado = 'LISTO';
  registrar_(
    c, s, q.tipo.toUpperCase() + '_RECUPERADO_POR_OPERADOR'
  );
}
function resumen_(c, mes) {
  exigir_(
    /^\d{4}-(0[1-9]|1[0-2])$/.test(mes || ''),
    'MES',
    'Usá AAAA-MM.'
  );

  const listado = listar_(c);
  const detalle = listado.ventas.filter(
    v => v.datos.fecha.slice(0, 7) === mes
  );
  const s = {
    mes: mes,
    criterio: 'Fecha de venta; incluye borradores, no es un libro IVA.',
    ventas: detalle.length,
    con_importes: 0,
    excluidas: 0,
    neto_centavos: 0,
    iva_centavos: 0,
    total_centavos: 0,
    estados_revision: {},
    estados_pdf: {},
    estados_correo: {},
    detalle: detalle,
    registros_ausentes: listado.ausentes
  };

  detalle.forEach(v => {
    [
      ['estados_revision', v.estado_revision],
      ['estados_pdf', v.pdf.estado],
      ['estados_correo', v.correo.estado]
    ].forEach(([k, valor]) => {
      s[k][valor] = (s[k][valor] || 0) + 1;
    });

    if (!v.importes || v.estado_revision === 'MODIFICADA') {
      s.excluidas++;
      return;
    }

    s.con_importes++;
    ['neto_centavos', 'iva_centavos', 'total_centavos'].forEach(k => {
      exigir_(
        Number.isSafeInteger(s[k] + v.importes[k]),
        'LIMITE',
        'Resumen fuera de límite.'
      );
      s[k] += v.importes[k];
    });
  });
  return s;
}
function ejecutar_(q) {
  const c = cargar_();
  if (q.accion === 'listar') return listar_(c);
  if (q.accion === 'resumen') return resumen_(c, q.mes);

  const r = fila_(c, q.uid);
  switch (q.accion) {
    case 'actualizar':
      actualizar_(c, r, q);
      break;
    case 'aprobar':
      aprobar_(c, r, q);
      break;
    case 'generar_pdf':
      crearArtefacto_(c, r, 'pdf');
      break;
    case 'crear_borrador':
      crearArtefacto_(c, r, 'correo');
      break;
    case 'revisar_operacion':
      return revisarOperacion_(c, r, q);
    case 'recuperar':
      recuperar_(c, r, q);
      break;
    default:
      fallo_('ACCION', 'Acción desconocida.');
  }
  return listar_(c);
}
function pruebasLogica() {
  const verificar = (ok, nombre) =>
    exigir_(ok, 'PRUEBA', nombre);
  const d = ejemplo_();
  const m = calcular_(1, 10000000);

  verificar(
    m.neto_centavos === 10000000 &&
    m.iva_centavos === 2100000 &&
    m.total_centavos === 12100000,
    '100000 + 21000 = 121000 pesos'
  );
  verificar(
    validar_(d, [d.id]).errores.length === 0,
    'Caso válido'
  );
  verificar(
    cuitValido_(d.emisor_cuit) && cuitValido_(d.cliente_cuit),
    'CUIT sintéticos'
  );
  verificar(
    validar_(
      Object.assign({}, d, { cliente_cuit: '20000000002' }),
      [d.id]
    ).errores.some(e => e.includes('CUIT')),
    'CUIT inválido'
  );
  verificar(
    validar_(
      Object.assign({}, d, { cliente_iva: '' }),
      [d.id]
    ).errores.some(e => e.includes('Falta condición')),
    'IVA faltante'
  );
  verificar(
    validar_(d, [d.id, d.id]).errores.includes('ID duplicado.'),
    'ID duplicado'
  );
  verificar(
    validar_(
      Object.assign({}, d, { concepto: '=IMPORTXML("x")' }),
      [d.id]
    ).errores.length > 0,
    'Fórmula bloqueada'
  );
  verificar(
    validar_(
      Object.assign({}, d, { alicuota: '' }),
      [d.id]
    ).errores.length > 0,
    'No hay IVA por defecto'
  );
  verificar(
    validar_(
      Object.assign({}, d, { moneda: 'USD' }),
      [d.id]
    ).errores.length > 0,
    'Moneda fuera de alcance'
  );
  verificar(
    calcular_(1, 150).iva_centavos === 32,
    'Redondeo de medio centavo'
  );

  console.log(
    '10 pruebas de lógica: OK. No se accedió a Google ni ARCA.'
  );
  return { pruebas: 10, resultado: 'OK' };
}

// Punto decimal opcional, máximo dos decimales.
// Sin comas, símbolo $, separadores de miles ni exponentes.
function pesosACentavos_(valor) {
  exigir_(typeof valor === 'string', 'PESOS',
    'Ingresá el precio como texto en pesos.');

  const texto = valor.trim();
  exigir_(
    /^(0|[1-9]\d*)(\.\d{1,2})?$/.test(texto),
    'PESOS',
    'Usá 100000 o 1.50, sin $ ni separadores de miles.'
  );

  const partes = texto.split('.');
  const centavos = Number(
    partes[0] + (partes[1] || '').padEnd(2, '0')
  );
  exigir_(Number.isSafeInteger(centavos), 'PESOS',
    'Precio fuera del límite de precisión.');
  return centavos;
}

function centavosAPesosTexto_(valor) {
  exigir_(entero_(valor), 'IMPORTE',
    'Se esperaban centavos enteros.');

  const digitos = String(Number(valor)).padStart(3, '0');
  return digitos.slice(0, -2) + '.' + digitos.slice(-2);
}

function datosParaHoja_(d) {
  return ENTRADAS.map(k =>
    k === 'precio_neto_centavos'
      ? centavosAPesosTexto_(d[k])
      : d[k]
  );
}

function datosDesdeHoja_(valores) {
  const d = datos_(valores);
  const entrada = d.precio_neto_centavos;

  try {
    d.precio_neto_centavos = String(pesosACentavos_(entrada));
  } catch (e) {
    if (e.codigo !== 'PESOS') throw e;

    // Conserva la entrada inválida para distinguir versiones.
    // Bloquea esa venta, sin impedir leer las demás filas.
    d.precio_neto_centavos = 'PESOS_INVALIDOS:' + entrada;
  }
  return d;
}


function pruebasPesos() {
  const verificar = (ok, nombre) =>
    exigir_(ok, 'PRUEBA', nombre);

  const convertir = precio => {
    const valores = datosParaHoja_(ejemplo_());
    valores[ENTRADAS.indexOf('precio_neto_centavos')] = precio;
    return datosDesdeHoja_(valores);
  };

  const grande = convertir('100000');
  const a = validar_(grande, [grande.id]);
  verificar(
    a.errores.length === 0 &&
    a.importes.neto_centavos === 10000000 &&
    a.importes.iva_centavos === 2100000 &&
    a.importes.total_centavos === 12100000,
    '100000 pesos'
  );

  const chico = convertir('1.50');
  const b = validar_(chico, [chico.id]);
  verificar(
    b.errores.length === 0 &&
    b.importes.neto_centavos === 150 &&
    b.importes.iva_centavos === 32 &&
    b.importes.total_centavos === 182,
    '1.50 pesos y redondeo'
  );

  const invalido = convertir('1,50');
  verificar(
    validar_(invalido, [invalido.id]).errores.some(
      e => e.includes('Precio neto en Sheets inválido')
    ),
    'Coma rechazada'
  );

  verificar(
    centavosAPesosTexto_(10000000) === '100000.00' &&
    centavosAPesosTexto_(150) === '1.50',
    'Escritura en pesos'
  );

  verificar(
    JSON.stringify(
      datosDesdeHoja_(datosParaHoja_(ejemplo_()))
    ) === JSON.stringify(ejemplo_()),
    'Ida y vuelta sin cambiar la huella de los datos'
  );

  console.log('5 pruebas de pesos: OK. Sin acceso a Google.');
  return { pruebas: 5, resultado: 'OK' };
}
