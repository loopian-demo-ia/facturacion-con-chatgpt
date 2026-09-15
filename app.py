import csv
import hashlib
import hmac
import io
import re
import time
from collections import Counter
from datetime import date, datetime, timezone
from decimal import Decimal
from urllib.parse import urlparse

import requests
import streamlit as st


MAX_ENTERO = 2**53 - 1
CLAVES = ("APP_PASSWORD", "GAS_URL", "GAS_SECRET", "SHEET_ID")

FIJOS = {
    "emisor": "Empresa Demo",
    "emisor_cuit": "30000000007",
    "emisor_iva": "RI",
    "cliente": "Cliente Demo",
    "cliente_cuit": "20000000001",
    "cliente_iva": "RI",
    "alicuota": "21",
    "moneda": "ARS",
    "operacion": "PRODUCTOS_LOCALES",
    "habilitacion": "A_COMUN_ASUMIDA",
}

ERRORES = {
    "NO_AUTORIZADO": "Apps Script rechazó el secreto. Revisá GAS_SECRET.",
    "ESQUEMA": "Revisá los encabezados y ejecutá inicializar en Apps Script.",
    "CONFIGURACION": "Falta configurar la planilla o carpeta en Apps Script.",
    "OCUPADO": "Hay otra operación en curso. Refrescá antes de continuar.",
    "VERSION_CAMBIO": "La venta cambió. Refrescá y revisá la nueva versión.",
    "NO_APROBADA": "Primero aprobá los datos actuales de la venta.",
    "VALIDACION": "La venta no pasó la validación. Refrescá y revisá sus errores.",
    "BLOQUEADA": "Hay un documento o intento conservado. Usá la sección avanzada.",
    "INCIERTO": (
        "Resultado incierto. No repitas la creación: "
        "refrescá y revisá la operación."
    ),
    "REVISION_REQUERIDA": "El intento requiere revisión en la sección avanzada.",
    "PDF_PENDIENTE": "Primero conservá el PDF.",
    "NO_ENCONTRADA": "No se encontró la venta. Refrescá la planilla.",
    "EDICION_INCIERTA": "Hay una edición interrumpida. Revisá Historial en Sheets.",
    "HISTORIAL": "El historial requiere revisión. No continúes creando documentos.",
    "UID": "Hay una clave interna alterada o duplicada. Revisá la columna uid.",
    "SIN_INTENTO": "No hay un intento registrado para revisar.",
    "NO_COINCIDE": "El objeto elegido no coincide con el intento registrado.",
    "ID_CONSERVADO": "No se puede reemplazar un ID ya conservado.",
    "REVISAR_PDF": "El PDF conservado no está disponible o cambió. Revisalo en Drive.",
    "REVISAR_CORREO": "El borrador conservado cambió. Revisalo en Gmail.",
}

ESTADOS = {
    "PENDIENTE": "Pendiente",
    "APROBADA": "Aprobada",
    "ERROR": "Con errores",
    "MODIFICADA": "Cambió después de aprobar",
    "LISTO": "Conservado",
    "EN_CURSO": "Intento pendiente de revisión",
    "INCIERTO": "Resultado incierto",
}


class ErrorApp(Exception):
    pass


def exigir(condicion, mensaje):
    if not condicion:
        raise ErrorApp(mensaje)


# Importes: texto/Decimal en la entrada, enteros en los cálculos.
def entero(valor):
    texto = str(valor)
    exigir(re.fullmatch(r"\d{1,16}", texto), "Se esperaba un entero no negativo.")
    numero = int(texto)
    exigir(numero <= MAX_ENTERO, "Importe fuera del límite seguro.")
    return numero


def pesos_a_centavos(texto):
    exigir(isinstance(texto, str), "Ingresá un precio en pesos.")
    texto = texto.strip()
    exigir(
        re.fullmatch(r"(0|[1-9]\d{0,15})(\.\d{1,2})?", texto),
        "Precio: usá 100000 o 1.50, sin $ ni separadores de miles.",
    )
    return entero(int(Decimal(texto) * Decimal(100)))


def pesos_texto(centavos):
    return format(Decimal(entero(centavos)) / Decimal(100), ".2f")


def dinero(centavos):
    pesos, decimales = pesos_texto(centavos).split(".")
    return "$ " + f"{int(pesos):,}".replace(",", ".") + "," + decimales


def cuit_valido(valor):
    s = str(valor)
    if not re.fullmatch(r"\d{11}", s):
        return False
    pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2]
    resto = 11 - sum(int(n) * p for n, p in zip(s[:10], pesos)) % 11
    return resto != 10 and int(s[-1]) == (0 if resto == 11 else resto)


def calcular(d):
    for valor in d.values():
        t = str(valor)
        exigir(
            len(t) <= 200
            and not re.search(r"[\x00-\x1f\x7f]", t)
            and not re.match(r"\s*[=+\-@']", t),
            "Hay texto no permitido en la venta.",
        )

    exigir(
        re.fullmatch(r"[A-Za-z0-9_-]{1,50}", d.get("id", "")),
        "Revisá el ID.",
    )
    try:
        exigir(
            date.fromisoformat(d["fecha"]).isoformat() == d["fecha"],
            "Revisá la fecha.",
        )
    except (KeyError, ValueError):
        raise ErrorApp("Fecha: usá AAAA-MM-DD.") from None

    for persona in ("emisor", "cliente"):
        exigir(
            d.get(persona + "_iva"),
            "Falta la condición IVA del " + persona + ".",
        )
        exigir(
            cuit_valido(d.get(persona + "_cuit", "")),
            "CUIT del " + persona + " inválido.",
        )

    exigir(
        all(str(d.get(k, "")) == v for k, v in FIJOS.items()),
        "Fuera de alcance: solo las empresas ficticias, RI, productos locales, "
        "ARS, 21 % y A común asumida.",
    )
    exigir(str(d.get("concepto", "")).strip(), "Completá el concepto.")

    cantidad = entero(d.get("cantidad", ""))
    precio = entero(d.get("precio_neto_centavos", ""))
    exigir(cantidad > 0 and precio > 0, "Cantidad y precio deben ser positivos.")

    neto = cantidad * precio
    exigir(
        neto * 21 + 50 <= MAX_ENTERO,
        "Importe fuera del límite de cálculo seguro.",
    )
    iva = (neto * 21 + 50) // 100
    return {
        "neto_centavos": neto,
        "iva_centavos": iva,
        "total_centavos": neto + iva,
    }


def validar_fila(v, ventas):
    exigir(not v.get("errores"), "Corregí los errores indicados por la planilla.")
    exigir(
        sum(x["datos"].get("id") == v["datos"].get("id") for x in ventas) == 1,
        "El ID está duplicado.",
    )

    calculado = calcular(v["datos"])
    recibido = v.get("importes")
    exigir(
        isinstance(recibido, dict)
        and all(
            type(recibido.get(k)) is int and recibido[k] == n
            for k, n in calculado.items()
        ),
        "Los importes no coinciden con el cálculo. Refrescá y revisá el backend.",
    )
    return calculado


def celda_csv(valor):
    texto = "" if valor is None else str(valor)
    inicio = re.sub(r"^[\s\x00-\x1f\ufeff]+", "", texto)
    if inicio.startswith(("=", "+", "-", "@")) or texto.startswith(
        ("\t", "\r", "\n")
    ):
        texto = "'" + texto
    return texto


def csv_bytes(filas):
    salida = io.StringIO(newline="")
    escritor = csv.writer(salida, delimiter=";", quoting=csv.QUOTE_ALL)
    escritor.writerows([[celda_csv(c) for c in fila] for fila in filas])
    return salida.getvalue().encode("utf-8-sig")


# Configuración y autenticación: permanecen en el servidor.
def configuracion():
    try:
        cfg = {k: str(st.secrets.get(k, "")) for k in CLAVES}
    except Exception:
        cfg = dict.fromkeys(CLAVES, "")

    faltan = [
        k for k, v in cfg.items()
        if not v or v.startswith("REEMPLAZAR")
    ]
    exigir(
        not faltan,
        "Configurá estas claves en Streamlit Secrets: " + ", ".join(faltan),
    )
    exigir(
        len(cfg["APP_PASSWORD"]) >= 16,
        "APP_PASSWORD debe tener al menos 16 caracteres.",
    )
    exigir(
        len(cfg["GAS_SECRET"]) >= 64,
        "GAS_SECRET debe ser el secreto completo de Apps Script.",
    )
    exigir(
        re.fullmatch(
            r"https://script\.google\.com/macros/s/[A-Za-z0-9_-]+/exec",
            cfg["GAS_URL"],
        ),
        "GAS_URL debe ser la dirección /exec de Apps Script, sin parámetros.",
    )
    exigir(
        re.fullmatch(r"[A-Za-z0-9_-]+", cfg["SHEET_ID"]),
        "Revisá SHEET_ID.",
    )
    return cfg


def comprobar_ingreso():
    escrito = st.session_state.pop("_clave", "")
    esperado = str(st.secrets.get("APP_PASSWORD", ""))
    correcto = hmac.compare_digest(escrito.encode(), esperado.encode())

    st.session_state["acceso"] = (
        hashlib.sha256(esperado.encode()).hexdigest() if correcto else ""
    )
    st.session_state["vence"] = time.time() + 3600 if correcto else 0
    st.session_state["login_error"] = not correcto


def autenticado(cfg):
    firma = hashlib.sha256(cfg["APP_PASSWORD"].encode()).hexdigest()
    return (
        st.session_state.get("acceso") == firma
        and time.time() < st.session_state.get("vence", 0)
    )


def api(cfg, accion, **datos):
    # Un solo POST: no hay reintentos automáticos.
    # La redirección de ContentService se sigue con GET, sin secreto.
    try:
        r = requests.post(
            cfg["GAS_URL"],
            json={"secreto": cfg["GAS_SECRET"], "accion": accion, **datos},
            timeout=(10, 75),
            allow_redirects=False,
        )

        if r.status_code in (302, 303):
            destino = r.headers.get("Location", "")
            u = urlparse(destino)
            exigir(
                u.scheme == "https"
                and u.netloc == "script.googleusercontent.com",
                "La implementación no devolvió el contenido esperado. "
                "Revisá acceso y publicación.",
            )
            r = requests.get(
                destino,
                timeout=(10, 75),
                allow_redirects=False,
            )

        exigir(
            r.status_code == 200,
            "Google no confirmó la solicitud. Refrescá antes de repetir.",
        )
        respuesta = r.json()
    except (requests.RequestException, ValueError):
        raise ErrorApp(
            "No se pudo confirmar la conexión. "
            "Refrescá; no repitas una creación incierta."
        ) from None

    exigir(isinstance(respuesta, dict), "Respuesta incompatible del backend.")
    if respuesta.get("ok") is not True:
        raise ErrorApp(
            ERRORES.get(
                respuesta.get("codigo"),
                "Apps Script no confirmó la operación. "
                "Revisá su configuración y refrescá.",
            )
        )

    exigir(
        isinstance(respuesta.get("datos"), dict),
        "Respuesta incompleta del backend.",
    )
    return respuesta["datos"]


def comprobar_listado(datos):
    exigir(
        isinstance(datos.get("ventas"), list)
        and isinstance(datos.get("ausentes"), list),
        "La respuesta no corresponde a listar. Revisá la versión de Code.gs.",
    )
    vistos = set()
    for v in datos["ventas"]:
        exigir(
            isinstance(v, dict)
            and isinstance(v.get("datos"), dict)
            and isinstance(v.get("pdf"), dict)
            and isinstance(v.get("correo"), dict)
            and isinstance(v.get("errores"), list)
            and isinstance(v.get("huella"), str)
            and isinstance(v.get("uid"), str),
            "Se recibió una venta incompleta.",
        )
        exigir(v["uid"] not in vistos, "Hay claves internas repetidas.")
        vistos.add(v["uid"])
    return datos


def limpiar_datos():
    for k in ("listado", "resumen", "recuperacion"):
        st.session_state.pop(k, None)


def cargar_ventas(cfg):
    limpiar_datos()
    st.session_state["listado"] = comprobar_listado(api(cfg, "listar"))
    st.session_state["lectura"] = datetime.now(timezone.utc).strftime(
        "%H:%M:%S UTC"
    )


def mutar(cfg, accion, venta, **datos):
    try:
        fresco = comprobar_listado(api(cfg, "listar"))
        actual = next(
            (x for x in fresco["ventas"] if x["uid"] == venta["uid"]),
            None,
        )
        exigir(
            actual and actual["huella"] == venta["huella"],
            "La venta cambió. Refrescá y revisá antes de continuar.",
        )
        if accion in ("aprobar", "generar_pdf", "crear_borrador"):
            validar_fila(actual, fresco["ventas"])

        parametros = {"uid": venta["uid"], **datos}
        if accion in ("actualizar", "aprobar"):
            parametros["huella"] = actual["huella"]

        resultado = comprobar_listado(api(cfg, accion, **parametros))
        limpiar_datos()
        st.session_state["listado"] = resultado
        st.session_state["lectura"] = datetime.now(timezone.utc).strftime(
            "%H:%M:%S UTC"
        )
        st.session_state["aviso"] = (
            "Resultado guardado y estados actualizados desde Sheets."
        )
    except ErrorApp as e:
        limpiar_datos()
        st.session_state["error"] = str(e)
    st.rerun()


def mostrar_importes(m):
    for columna, k, titulo in zip(
        st.columns(3), m, ("Neto", "IVA 21 %", "Total")
    ):
        columna.metric(titulo, dinero(m[k]))


def tabla_ventas(ventas):
    filas = []
    for v in ventas:
        try:
            m = validar_fila(v, ventas)
        except ErrorApp:
            m = {}
        filas.append({
            "ID": v["datos"].get("id", ""),
            "Fecha": v["datos"].get("fecha", ""),
            "Cliente": v["datos"].get("cliente", ""),
            "Total": (
                dinero(m["total_centavos"])
                if type(m.get("total_centavos")) is int
                else "Sin calcular"
            ),
            "Revisión": ESTADOS.get(v.get("estado_revision"), "Revisar"),
            "PDF": ESTADOS.get(v["pdf"].get("estado"), "Revisar"),
            "Correo": ESTADOS.get(v["correo"].get("estado"), "Revisar"),
        })
    st.dataframe(filas, hide_index=True, width="stretch")


def formulario(cfg, v):
    d = v["datos"]
    bloqueada = any(
        v[t].get("estado") != "PENDIENTE" for t in ("pdf", "correo")
    )
    if bloqueada:
        st.info(
            "Hay un documento o intento conservado. "
            "Esta venta no admite correcciones."
        )
        return

    precio = str(d.get("precio_neto_centavos", ""))
    if precio.startswith("PESOS_INVALIDOS:"):
        precio = precio.split(":", 1)[1]
    else:
        try:
            precio = pesos_texto(precio)
        except ErrorApp:
            precio = ""

    with st.form("editar_" + v["uid"] + v["huella"]):
        nuevo = dict(d)
        a, b = st.columns(2)
        nuevo["id"] = a.text_input("ID de venta", value=d.get("id", ""))
        nuevo["fecha"] = b.text_input(
            "Fecha · AAAA-MM-DD", value=d.get("fecha", "")
        )
        nuevo["concepto"] = st.text_input(
            "Producto", value=d.get("concepto", "")
        )
        a, b = st.columns(2)
        nuevo["cantidad"] = a.text_input(
            "Cantidad entera", value=str(d.get("cantidad", ""))
        )
        entrada = b.text_input(
            "Precio NETO unitario en pesos",
            value=precio,
            max_chars=32,
            help="Punto decimal, sin miles: 100000 o 1.50.",
        )

        with st.expander("Datos fiscales y alcance"):
            for persona in ("emisor", "cliente"):
                a, b, c = st.columns(3)
                nuevo[persona] = a.text_input(
                    persona.capitalize(), value=d.get(persona, "")
                )
                nuevo[persona + "_cuit"] = b.text_input(
                    "CUIT " + persona, value=d.get(persona + "_cuit", "")
                )
                nuevo[persona + "_iva"] = c.text_input(
                    "Condición IVA " + persona,
                    value=d.get(persona + "_iva", ""),
                    help="RI",
                )

            campos = (
                ("moneda", "Moneda"),
                ("alicuota", "Alícuota"),
                ("operacion", "Operación"),
                ("habilitacion", "Habilitación asumida"),
            )
            for k, titulo in campos:
                actual = str(d.get(k, ""))
                opciones = list(dict.fromkeys([actual, FIJOS[k]]))
                nuevo[k] = st.selectbox(
                    titulo,
                    opciones,
                    help="Único valor admitido: " + FIJOS[k],
                )

        guardar = st.form_submit_button(
            "Guardar corrección", type="primary"
        )

    if guardar:
        try:
            nuevo = {k: str(valor).strip() for k, valor in nuevo.items()}
            nuevo["precio_neto_centavos"] = str(
                pesos_a_centavos(entrada)
            )
            calcular(nuevo)
            # Apps Script vuelve a validar, incluida unicidad del ID.
            mutar(cfg, "actualizar", v, datos=nuevo)
        except ErrorApp as e:
            st.error(str(e))


def recuperacion(cfg, v):
    with st.expander("Avanzado · Revisar una operación incierta"):
        st.caption(
            "No se reintenta automáticamente. Una búsqueda vacía "
            "no demuestra que el objeto no exista."
        )
        tipo = st.selectbox(
            "Objeto", ("pdf", "correo"), key="tipo_" + v["uid"]
        )
        if st.button("Buscar el objeto existente"):
            st.session_state.pop("recuperacion", None)
            try:
                resultado = api(
                    cfg, "revisar_operacion", uid=v["uid"], tipo=tipo
                )
                exigir(
                    isinstance(resultado.get("candidatos"), list),
                    "Respuesta de revisión incompleta.",
                )
                st.session_state["recuperacion"] = (
                    v["uid"], tipo, resultado
                )
            except ErrorApp as e:
                st.error(str(e))

        guardado = st.session_state.get("recuperacion")
        if guardado and guardado[:2] == (v["uid"], tipo):
            resultado = guardado[2]
            st.caption(
                "Referencia del intento: "
                + str(resultado.get("datos_aprobados", {}).get("id", ""))
            )
            candidatos = resultado["candidatos"]
            if not candidatos:
                st.warning(
                    "No se encontraron coincidencias. "
                    "Conservamos el bloqueo para revisión manual."
                )
            else:
                ids = [str(x["id"]) for x in candidatos]
                elegido = st.selectbox("ID encontrado", ids)
                if tipo == "pdf" and re.fullmatch(
                    r"[A-Za-z0-9_-]+", elegido
                ):
                    st.link_button(
                        "Abrir PDF para revisarlo",
                        f"https://drive.google.com/file/d/{elegido}/view",
                    )
                confirmado = st.checkbox(
                    "Abrí el objeto y comprobé que corresponde a esta venta."
                )
                if st.button(
                    "Vincular objeto revisado", disabled=not confirmado
                ):
                    mutar(
                        cfg,
                        "recuperar",
                        v,
                        tipo=tipo,
                        id=elegido,
                        confirmacion="REVISE_EL_DOCUMENTO",
                    )


def validar_resumen(s, mes):
    detalle = s.get("detalle")
    exigir(
        s.get("mes") == mes and isinstance(detalle, list),
        "Resumen incompatible.",
    )
    comprobar_listado({
        "ventas": detalle,
        "ausentes": s.get("registros_ausentes", []),
    })
    suma = dict(neto_centavos=0, iva_centavos=0, total_centavos=0)
    incluidos = 0

    for v in detalle:
        exigir(
            v["datos"].get("fecha", "").startswith(mes + "-"),
            "El resumen mezcla meses.",
        )
        if (
            not v.get("importes")
            or v.get("estado_revision") == "MODIFICADA"
        ):
            continue
        m = validar_fila(v, detalle)
        incluidos += 1
        for k in suma:
            suma[k] = entero(suma[k] + m[k])

    esperados = {
        **suma,
        "ventas": len(detalle),
        "con_importes": incluidos,
        "excluidas": len(detalle) - incluidos,
    }
    exigir(
        all(
            type(s.get(k)) is int and s[k] == n
            for k, n in esperados.items()
        ),
        "Los totales del resumen no coinciden. "
        "Refrescá y revisá la planilla.",
    )

    grupos = (
        ("estados_revision", [v.get("estado_revision") for v in detalle]),
        ("estados_pdf", [v["pdf"].get("estado") for v in detalle]),
        ("estados_correo", [v["correo"].get("estado") for v in detalle]),
    )
    for nombre, valores in grupos:
        exigir(
            s.get(nombre) == dict(Counter(valores)),
            "Los estados del resumen no coinciden.",
        )
    return s


def exportar(s):
    detalle = [[
        "Mes", "UID", "ID", "Fecha", "Cliente", "Concepto",
        "Incluida en totales", "Neto ARS", "IVA ARS", "Total ARS",
        "Revisión", "PDF", "Correo", "Resultado fiscal", "Errores",
    ]]
    for v in s["detalle"]:
        d = v["datos"]
        m = v.get("importes") or {}
        incluido = bool(m) and v.get("estado_revision") != "MODIFICADA"
        detalle.append([
            s["mes"], v["uid"], d.get("id"), d.get("fecha"),
            d.get("cliente"), d.get("concepto"),
            "Sí" if incluido else "No",
            *[
                pesos_texto(m[k]) if k in m else ""
                for k in ("neto_centavos", "iva_centavos", "total_centavos")
            ],
            v.get("estado_revision"),
            v["pdf"].get("estado"),
            v["correo"].get("estado"),
            v.get("resultado_fiscal"),
            " | ".join(v.get("errores", [])),
        ])

    resumen = [
        ["Mes", "Grupo", "Concepto", "Valor"],
        [
            s["mes"], "Alcance", "Documento",
            "Resumen operativo; no es declaración fiscal ni libro IVA",
        ],
    ]
    for k in ("ventas", "con_importes", "excluidas"):
        resumen.append([s["mes"], "Cantidades", k, s[k]])

    for k in ("neto_centavos", "iva_centavos", "total_centavos"):
        resumen.append([
            s["mes"], "Importes ARS",
            k.replace("_centavos", ""), pesos_texto(s[k]),
        ])

    for grupo in ("estados_revision", "estados_pdf", "estados_correo"):
        for estado, cantidad in s[grupo].items():
            resumen.append([s["mes"], grupo, estado, cantidad])

    resumen.append([
        s["mes"], "Control",
        "Registros ausentes en Sheets (todos los meses)",
        len(s.get("registros_ausentes", [])),
    ])
    return csv_bytes(detalle), csv_bytes(resumen)


def main():
    st.set_page_config(
        page_title="De la venta al comprobante",
        page_icon="🧾",
        layout="wide",
    )
    st.markdown("""
    <style>
    .stApp,[data-testid="stHeader"]{background:#f7f7fc;color:#24113e}
    .block-container{max-width:1100px;padding-top:1.1rem;padding-bottom:2rem}
    h1{font-size:2rem!important;color:#32145b}
    h2,h3,label{color:#32145b!important}
    .demo{background:#e5f6b9;border-left:5px solid #9dbb32;
          padding:9px 14px;border-radius:8px;color:#263611;
          font-weight:700;margin-bottom:12px}
    [data-testid="stMetric"]{background:white;border:1px solid #e8e0f2;
                           border-radius:12px;padding:12px}
    [data-baseweb="input"],[data-baseweb="select"]>div,
    [data-testid="stForm"]{background:white;color:#24113e}
    input{color:#24113e!important}
    [data-testid="stBaseButton-primary"],
    [data-testid="stBaseButton-primaryFormSubmit"]{
      background:#45206f;color:white;border-color:#45206f}
    button[role="tab"][aria-selected="true"]{
      color:#45206f;border-bottom:3px solid #a5cf3b}
    @media(max-width:600px){
      .block-container{padding:1rem}
      .stApp h1{font-size:1.65rem!important}
    }
    </style>
    """, unsafe_allow_html=True)

    st.title("De la venta al comprobante")
    st.markdown(
        '<div class="demo">BORRADOR · Sin autorización fiscal</div>',
        unsafe_allow_html=True,
    )

    try:
        cfg = configuracion()
    except ErrorApp as e:
        st.info(str(e))
        st.stop()

    if not autenticado(cfg):
        limpiar_datos()
        with st.form("ingreso", clear_on_submit=True):
            st.text_input(
                "Contraseña de acceso", type="password", key="_clave"
            )
            st.form_submit_button(
                "Ingresar", on_click=comprobar_ingreso
            )
        if st.session_state.get("login_error"):
            st.error("La contraseña no es correcta.")
        st.stop()

    a, b, c = st.columns(3)
    refrescar = a.button("Refrescar desde Sheets", width="stretch")
    b.link_button(
        "Abrir planilla",
        f'https://docs.google.com/spreadsheets/d/{cfg["SHEET_ID"]}/edit',
        width="stretch",
    )
    if c.button("Cerrar sesión", width="stretch"):
        st.session_state.clear()
        st.rerun()

    if aviso := st.session_state.pop("aviso", None):
        st.success(aviso)
    error = st.session_state.pop("error", None)
    if error:
        st.error(error)

    if refrescar or ("listado" not in st.session_state and not error):
        try:
            with st.spinner("Leyendo la planilla…"):
                cargar_ventas(cfg)
        except ErrorApp as e:
            st.error(str(e))

    if "listado" not in st.session_state:
        st.info(
            "Sin datos confirmados. Revisá la configuración "
            "y tocá Refrescar desde Sheets."
        )
        st.stop()

    listado = st.session_state["listado"]
    ventas = listado["ventas"]
    st.caption(
        "Datos leídos de Sheets · "
        + st.session_state.get("lectura", "")
        + " · No se actualizan solos: usá Refrescar."
    )
    if listado["ausentes"]:
        st.warning(
            "Hay registros en Historial cuya fila falta en Ventas. "
            "Revisalos antes de usar el resumen."
        )

    with st.expander("Cómo funciona"):
        st.caption(
            "Circuito implementado; las llamadas reales "
            "se verifican en tu cuenta."
        )
        st.graphviz_chart('''digraph {
          graph [rankdir=TB, bgcolor="transparent"];
          node [shape=box, style="rounded,filled",
                fillcolor="#eee8f7", color="#45206f"];
          sheets [label="Google Sheets"];
          revision [label="Revisión y aprobación"];
          pdf [label="PDF de borrador en Drive"];
          gmail [label="Borrador en Gmail"];
          resumen [label="Resumen mensual"];
          arca [label="ARCA · pendiente", fillcolor="#f2f2f2"];
          sheets -> revision;
          sheets -> resumen;
          revision -> pdf;
          pdf -> gmail;
          revision -> arca [style=dashed];
        }''')
        st.caption(
            "ARCA: faltan certificado de homologación, permisos WSASS "
            "y configuración de prueba. Este código no solicita CAE "
            "ni implementa producción."
        )

    v = None
    if ventas:
        por_uid = {x["uid"]: x for x in ventas}
        uid = st.selectbox(
            "Venta",
            list(por_uid),
            format_func=lambda k: (
                f'{por_uid[k]["datos"].get("id", "Sin ID")} · {k[:8]}'
            ),
        )
        v = por_uid[uid]

    revisar, preparar, mensual = st.tabs([
        "Revisar ventas", "Preparar", "Resumen mensual"
    ])

    with revisar:
        if not ventas:
            st.info(
                "La planilla está vacía. Cargá una fila "
                "o ejecutá cargarEjemplo en Apps Script."
            )
        else:
            tabla_ventas(ventas)
            for mensaje in v["errores"]:
                st.error(str(mensaje))
            try:
                mostrar_importes(validar_fila(v, ventas))
            except ErrorApp as e:
                st.info(str(e))
            st.caption(
                "CUIT válido localmente no acredita inscripción. "
                "Todas las identidades son ficticias."
            )
            formulario(cfg, v)

    with preparar:
        if v:
            st.text("Venta: " + v["datos"].get("id", ""))
            valido = True
            try:
                mostrar_importes(validar_fila(v, ventas))
            except ErrorApp as e:
                valido = False
                st.warning(str(e))

            aprobada = v.get("estado_revision") == "APROBADA"
            confirmado = st.checkbox(
                "Revisé los datos y los importes de esta versión.",
                key="confirmar_" + v["uid"] + v["huella"],
            )
            if st.button(
                "Aprobar venta",
                disabled=not (valido and confirmado) or aprobada,
            ):
                mutar(cfg, "aprobar", v)

            st.caption(
                "Revisión: "
                + ESTADOS.get(v.get("estado_revision"), "Revisar")
            )
            a, b = st.columns(2)

            puede_pdf = (
                valido and aprobada
                and v["pdf"].get("estado") in ("PENDIENTE", "LISTO")
            )
            if a.button(
                "Conservar / verificar PDF",
                type="primary",
                width="stretch",
                disabled=not puede_pdf,
            ):
                mutar(cfg, "generar_pdf", v)

            puede_correo = (
                valido and aprobada
                and v["pdf"].get("estado") == "LISTO"
                and v["correo"].get("estado") in ("PENDIENTE", "LISTO")
            )
            if b.button(
                "Crear / verificar borrador Gmail",
                width="stretch",
                disabled=not puede_correo,
            ):
                mutar(cfg, "crear_borrador", v)

            st.caption(
                "PDF: " + ESTADOS.get(v["pdf"].get("estado"), "Revisar")
                + " · Correo: "
                + ESTADOS.get(v["correo"].get("estado"), "Revisar")
                + " · La app no envía mensajes."
            )
            pdf_id = str(v["pdf"].get("id", ""))
            if pdf_id and re.fullmatch(r"[A-Za-z0-9_-]+", pdf_id):
                st.link_button(
                    "Abrir PDF conservado",
                    f"https://drive.google.com/file/d/{pdf_id}/view",
                )

            st.link_button(
                "Abrir borradores de Gmail",
                "https://mail.google.com/mail/u/0/#drafts",
            )
            st.caption(
                "Usá la cuenta de demostración. "
                "El correo se prepara para esa misma cuenta."
            )
            recuperacion(cfg, v)
        else:
            st.info("Primero cargá una venta.")

    with mensual:
        mes = st.text_input(
            "Mes · AAAA-MM", value=date.today().strftime("%Y-%m")
        )
        if st.button("Consultar resumen"):
            st.session_state.pop("resumen", None)
            try:
                exigir(
                    re.fullmatch(r"\d{4}-(0[1-9]|1[0-2])", mes),
                    "Mes: usá AAAA-MM.",
                )
                st.session_state["resumen"] = validar_resumen(
                    api(cfg, "resumen", mes=mes), mes
                )
            except ErrorApp as e:
                st.error(str(e))

        s = st.session_state.get("resumen")
        if s and s["mes"] == mes:
            st.caption(
                "Por fecha de venta. Resumen operativo; "
                "no es declaración fiscal ni libro IVA."
            )
            mostrar_importes({
                k: s[k]
                for k in ("neto_centavos", "iva_centavos", "total_centavos")
            })
            st.write(
                f'Ventas: {s["ventas"]} · '
                f'Con importes: {s["con_importes"]} · '
                f'Excluidas: {s["excluidas"]}'
            )

            for columna, grupo, titulo in zip(
                st.columns(3),
                ("estados_revision", "estados_pdf", "estados_correo"),
                ("Revisión", "PDF", "Correo"),
            ):
                columna.write(titulo)
                columna.dataframe(
                    [
                        {"Estado": ESTADOS.get(k, k), "Cantidad": n}
                        for k, n in s[grupo].items()
                    ],
                    hide_index=True,
                )

            if s.get("registros_ausentes"):
                st.warning(
                    "Hay filas ausentes. Los totales no incluyen esas "
                    "ventas: revisá Historial."
                )

            detalle, totales = exportar(s)
            a, b = st.columns(2)
            a.download_button(
                "Descargar detalle CSV",
                detalle,
                f"ventas-{mes}.csv",
                "text/csv",
            )
            b.download_button(
                "Descargar totales y estados CSV",
                totales,
                f"resumen-{mes}.csv",
                "text/csv",
            )


if __name__ == "__main__":
    main()
