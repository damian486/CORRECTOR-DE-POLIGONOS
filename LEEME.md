# Corrector de Polígonos — APK

App para Android que revisa capas de parcelas y ayuda a corregirlas. Funciona sin internet, salvo el mapa de fondo y las consultas a Claude.

## Qué revisa

- **Errores de geometría**: bordes que se cruzan (forma de moño), anillos sin cerrar, puntos repetidos.
- **Parcelas encimadas** (traslapes) entre dos polígonos.
- **Huecos** pequeños que quedan entre parcelas vecinas.
- **Copias repetidas** del mismo polígono.
- **Astillas**: polígonos demasiado pequeños, casi siempre errores al dibujar.

Toca cualquier parcela para ver su área y atributos, **editar su forma** (mover, agregar y borrar puntos del borde) o borrarla completa.

En la pestaña **Datos** puedes agregar un campo nuevo (por ejemplo `BENEF` para el nombre del beneficiario) y llenarlo polígono por polígono; la lista muestra primero los que no tienen dato. También puedes editar todos los atributos de una parcela desde su ventana con **Editar datos**. Los nombres de campo del shape admiten hasta 10 letras, sin espacios ni tildes.

Puedes abrir **hasta 4 capas a la vez** (por ejemplo SAF y reforestación): al abrir el segundo archivo elige "Agregar como otra capa" y la app revisa también los traslapes entre capas. Cada capa se guarda por separado, o todas juntas con un campo `CAPA`.

Cada problema trae botones para corregirlo (por ejemplo "Quitar de Ana" o "Unir a Benito"), y el botón de deshacer revierte el último cambio. Las áreas se muestran en m², cuerdas (30 × 30 varas) y hectáreas.

## Formatos

Abre shape en **.zip** (con .shp, .shx, .dbf y .prj), **GeoJSON**, **KML** y **KMZ**. Guarda el resultado como shape en .zip, GeoJSON o **Excel (.xlsx)** con los atributos, áreas (m², cuerdas, hectáreas), coordenadas del centro de cada parcela y la lista de problemas pendientes, en **Descargas › Corrector de Poligonos**.

Lee shapes en **GTM** (y en cualquier otro sistema que venga en su .prj). Si un shape no trae .prj pero sus coordenadas tienen valores de GTM, también lo lee como GTM. Al guardar eliges si el shape va en **GTM** o en **WGS84**; por defecto usa el mismo del original. Las áreas se calculan en GTM, igual que en QGIS con una capa en GTM.

## Cómo obtener el APK

1. Crea un repositorio nuevo en GitHub y sube **todo** el contenido de esta carpeta, incluida la carpeta oculta `.github`.
2. Entra a la pestaña **Actions**. Verás "Construir APK" trabajando (tarda unos 3 a 5 minutos).
3. Cuando tenga la palomita verde, entra a esa ejecución y baja hasta **Artifacts**.
4. Descarga **CorrectorPoligonos-apk** (viene en un .zip), descomprímelo e instala **CorrectorPoligonos.apk**.

## Versión web (GitHub Pages)

El archivo `index.html` de la raíz es la misma app en un solo archivo, para usarla desde el navegador (computadora o iPhone). Para activarla: en el repositorio ve a **Settings › Pages**, elige *Deploy from a branch*, rama **main**, carpeta **/(root)**, y guarda. Queda en `https://TU-USUARIO.github.io/NOMBRE-DEL-REPOSITORIO/`.

Si cambias la app, este `index.html` hay que volver a generarlo; pídele a Claude la versión nueva.

## Claude dentro de la app

1. Crea una cuenta en **console.anthropic.com**, carga saldo y genera una clave de API.
2. En la app, toca el engranaje (Ajustes) y pega la clave. Se guarda solo en ese teléfono.
3. En la pestaña **Claude** puedes pedirle que revise todo, que decida los traslapes o que asigne los huecos. También puedes adjuntar un **PDF** de referencia, como un croquis o la lista de beneficiarios.

Claude propone correcciones y tú las aplicas con un botón. La app hace los cambios en el teléfono. A Claude solo se le envían los problemas y los atributos de las parcelas involucradas, no la capa completa.

Se paga por uso, aparte de la suscripción de Claude. Revisar una capa de parcelas cuesta centavos. Si Claude responde que no encuentra el modelo, cambia el nombre del modelo en Ajustes.

No compartas el APK con tu clave puesta: la clave queda en el teléfono donde la escribiste, no dentro del APK, así que cada persona que lo instale debe poner la suya.

## Para cambiar la app

Los archivos de la app están en `app/src/main/assets/` (`index.html`, `app.js` y `motor.js`). Al subir un cambio, GitHub construye el APK nuevo solo. En `app/build.gradle` sube `versionCode` (1 → 2 → 3…) en cada versión.

No borres ni cambies `app/llave.keystore`: con esa llave el APK nuevo se instala encima del anterior.

## Límites

- Con capas de miles de polígonos la revisión se pone lenta. Para eso conviene QGIS.
- El mapa de fondo (satélite o calles) necesita internet. Sin señal se ven igual los polígonos sobre fondo gris.
- Los textos de la tabla de atributos se guardan con codificación ISO-8859-1 (acentos y ñ funcionan; caracteres fuera del español pueden perderse).
