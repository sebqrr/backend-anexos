const PizZip = require("pizzip");
const Docxtemplater = require("docxtemplater");
const fs = require("fs");
const path = require("path");
const Anexo = require("../models/Anexo");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const PDFParser = require("pdf2json");

// Configuración de Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const multer = require("multer");

// Configuración de almacenamiento
const storageTemplates = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "storage/templates/"),
  filename: (req, file, cb) => cb(null, file.originalname),
});

const storageUploads = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadPath = path.resolve(__dirname, "../storage/uploads");
    if (!fs.existsSync(uploadPath))
      fs.mkdirSync(uploadPath, { recursive: true });
    cb(null, "storage/uploads/");
  },
  filename: (req, file, cb) => cb(null, Date.now() + "-" + file.originalname),
});

exports.upload = multer({ storage: storageTemplates });
exports.uploadTecnico = multer({ storage: storageUploads }).single(
  "pdfTecnico",
);

// --- FUNCIÓN AUXILIAR PARA PDF2JSON ---
function extraerTextoPDF(rutaArchivo) {
  return new Promise((resolve, reject) => {
    const pdfParser = new PDFParser(this, 1);
    pdfParser.on("pdfParser_dataError", (errData) =>
      reject(errData.parserError),
    );
    pdfParser.on("pdfParser_dataReady", (pdfData) => {
      const rawText = pdfParser.getRawTextContent();
      resolve(rawText);
    });
    pdfParser.loadPDF(rutaArchivo);
  });
}

// 1. Subir Plantilla
exports.subirPlantilla = (req, res) => {
  if (!req.file) return res.status(400).send("No file.");
  res.send({ message: "Plantilla subida", filename: req.file.filename });
};

// 2. Generar Manual
exports.generarAnexo = async (req, res) => {
  try {
    const templateName = req.body.nombrePlantilla || "plantilla_prueba.docx";
    const datos = req.body.datos || {};
    const templatePath = path.resolve(
      __dirname,
      "../storage/templates",
      templateName,
    );
    if (!fs.existsSync(templatePath))
      return res.status(404).json({ error: "Plantilla no encontrada" });

    const content = fs.readFileSync(templatePath, "binary");
    const zip = new PizZip(content);
    const doc = new Docxtemplater(zip, {
      paragraphLoop: true,
      linebreaks: true,
    });
    doc.render(datos);
    const buf = doc
      .getZip()
      .generate({ type: "nodebuffer", compression: "DEFLATE" });

    await new Anexo({
      nombrePlantilla: templateName,
      datosRellenados: datos,
      usuarioId: req.user.id, //nuevo campo para relacionar con el usuario
    }).save();

    res.setHeader(
      "Content-Disposition",
      "attachment; filename=anexo_final.docx",
    );
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    res.send(buf);
  } catch (error) {
    res.status(500).json({ error: "Error manual" });
  }
};

// 3. GENERACIÓN INTELIGENTE
exports.generarAnexoInteligente = async (req, res) => {
  try {
    if (!req.file)
      return res.status(400).json({ error: "Falta subir el PDF técnico" });

    // 🔵 NUEVO: DATOS MANUALES DESDE FRONTEND
    const {
      rut_organismo,
      nombre_organismo,
      telefono_organismo,
      direccion_organismo,
      comuna_organismo,
      region_organismo,
    } = req.body;

    console.log(
      "📄 Extrayendo texto masivo con PDF2JSON:",
      req.file.originalname,
    );

    // A. LEER TEXTO LOCALMENTE
    let textoCompleto = "";
    try {
      textoCompleto = await extraerTextoPDF(req.file.path);
      console.log("✅ Texto extraído. Longitud:", textoCompleto.length);
    } catch (errPdf) {
      console.error("❌ Error leyendo PDF:", errPdf);
      return res
        .status(500)
        .json({ error: "No se pudo leer el PDF: " + errPdf });
    }

    console.log("🤖 Analizando TODO el documento con Gemini 2.5 Flash...");

    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

// --- AQUÍ ESTÁ LA MAGIA: EL PROMPT GIGANTE (VERSIÓN ANTI-UNDEFINED) ---
    const prompt = `
    Actúa como un experto técnico en licitaciones SENCE.
    Tu misión es generar el "Anexo N° 2" replicando EXACTAMENTE el formato administrativo oficial SENCE.

      Texto a analizar:
      "${textoCompleto.substring(0, 70000)}"

    ================ REGLAS OBLIGATORIAS =================

    1. DETECCIÓN DE PARTICIPANTES
    - Detectar número total de cupos.
    - Si no aparece, asumir segun el texto indique la cantidad de participantes o el número de equipos segun corresponda.
    - Guardar como TOTAL_PARTICIPANTES o usarlo cuando sea necesario en caso de que se pida y este claro en el PDF.
    - Solo los calculos necesarios deben basarse en este número, si el PDF es claro al respecto. No asumir números arbitrarios.
    - Si el PDF no es claro, volver a revisar el texto para detectar pistas sobre la cantidad de participantes o equipos, y usar ese número como referencia para corregir cualquier inconsistencia en las tablas.
    - No inventar números de participantes ni de equipos. Usar solo lo que el PDF indique o lo que se pueda inferir claramente del texto.
    - Colocar las unidades de medida de cada equipo o material segun corresponda, y asegurarse que coincidan con singular/plural segun el número detectado y el texto o numero del PDF.


    2. DETECCIÓN DE MÓDULOS
    - Detectar números de módulos.
    - El campo "modulo" solo puede contener números separados por coma.
      Ejemplo: "1,2,3,4,5"
    - Prohibido usar texto como "Todos los módulos".

    3. PROHIBIDO VALORES VACÍOS
    - No usar null, undefined o "".
    - Si no existe información usar "—".

    4. UNIDADES PERMITIDAS
    Solo usar:
    - Unidad / Unidades
    - Kit / Kits
    - Set / Sets
    - Global
    

    Reglas:
    - 1 → singular
    - >1 → plural
    - No inventar unidades.

    ------------------------------------------------------
    5. TABLA 7 – EQUIPOS (REGLA MATEMÁTICA OBLIGATORIA)
    ------------------------------------------------------

    DEFINICIONES:
    - cantidad = total de equipos disponibles.
    - num_participantes = personas que utilizan un mismo equipo.
    - TOTAL_PARTICIPANTES = cupos detectados.

    REGLA OBLIGATORIA: debe cumplirse UNA de estas ecuaciones:

    1) Equipo individual por participante
      cantidad = TOTAL_PARTICIPANTES
      num_participantes = 1
      La descripción debe incluir "por participante".

    2) Equipo del facilitador
      cantidad = 1
      num_participantes = TOTAL_PARTICIPANTES

    3) Equipo grupal compartido
      cantidad = 1
      num_participantes = TOTAL_PARTICIPANTES

    PROHIBIDO:
    - cantidad > 1 Y num_participantes > 1
    - cantidad ≠ TOTAL_PARTICIPANTES si dice "por participante"
    - num_participantes = 1 si cantidad = 1 y no dice "por participante"

    REGLA DE PRIORIDAD SI EL PDF NO ES CLARO:
    - Computador → tipo 1
    - Notebook facilitador → tipo 2
    - Proyector / Telón / Pizarrón / Cámara → tipo 3

    ------------------------------------------------------
    CERTIFICACIÓN
    ------------------------------------------------------

    - Notebook / PC / Computador / Proyector → "Cert. SEC"
    - Telón / Pizarrón / Cámara / Filmadora → "No aplica"

    No depender del texto del PDF.
    Seguir patrón administrativo oficial.

    ------------------------------------------------------
    ANTIGÜEDAD
    ------------------------------------------------------

    - Equipos tecnológicos → "Menos de 2 años" o segun el texto si es claro.
    - Equipos físicos → "Menos de 2 años" o segun el texto si es claro.
    - Insumos → "No aplica" o segun el texto si es claro.

    ------------------------------------------------------
    6. TABLA 8 – MATERIALES (REGLA MATEMÁTICA OBLIGATORIA)
    ------------------------------------------------------

    DEFINICIONES:
    - cantidad = total de unidades disponibles.
    - num_participantes = personas que usan UNA unidad.

    REGLAS:

    1) Material individual
      cantidad = TOTAL_PARTICIPANTES
      num_participantes = 1

    2) Material grupal
      cantidad = 1
      num_participantes = TOTAL_PARTICIPANTES

    3) Libro de clases
      cantidad = 1
      num_participantes = TOTAL_PARTICIPANTES

    4) Plumones para pizarrón
      cantidad = 1 Set
      num_participantes = TOTAL_PARTICIPANTES

    PROHIBIDO:
    - cantidad > 1 Y num_participantes > 1
    - Libro de clases con num_participantes = 1
    - Plumones con num_participantes = 1

    Si alguna regla se incumple, corregir automáticamente usando el texto o los números correspondientes del PDF como referencia.

    ------------------------------------------------------
    7. DURACIÓN
    ------------------------------------------------------

    Extraer:
    - horas_totales
    - dias
    - meses

    Si solo existe uno, los demás deben ser "—".

    Ejemplo:
    Si dice "Duración total: 40 horas":
    horas_totales = 40
    dias = "—"
    meses = "—"

    ======================================================
    VALIDACIÓN FINAL OBLIGATORIA
    ======================================================

    Antes de responder:
    - Verificar que ninguna fila viole las reglas matemáticas.
    - Verificar que no existan valores vacíos.
    - Verificar coherencia entre cantidad, num_participantes y el texto.
    - Verificar que las unidades coincidan con singular/plural segun el número.

    ======================================================
    ESTRUCTURA JSON EXACTA
    ======================================================

    {
      "nombre_curso": "...",
      "horas_totales": "...",
      "dias": "...",
      "meses": "...",
      "lista_equipos": [
        {
          "descripcion": "...",
          "modulo": "...",
          "cantidad": "...",
          "unidad_medida": "...",
          "num_participantes": "...",
          "antiguedad": "...",
          "certificacion": "..."
        }
      ],
      "lista_materiales": [
        {
          "descripcion": "...",
          "cantidad": "...",
          "modulo": "...",
          "num_participantes": "..."
          "unidad_medida": "...",
        }
      ],
      "objetivo_general": "...",
      "contenidos_resumen": "...",
      "infraestructura_sala": "...",
      "infraestructura_taller": "...",
      "metodologia": "...",
      "mecanismos_evaluacion": "..."
    }

    Responder SOLO con el JSON válido.
    `;




    const result = await model.generateContent(prompt);
    const response = await result.response;
    let textoLimpio = response
      .text()
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();

    let datosExtraidos;
    try {
      datosExtraidos = JSON.parse(textoLimpio);
    } catch (e) {
      console.error("JSON inválido de IA:", textoLimpio);
      return res
        .status(500)
        .json({ error: "La IA respondió pero no en formato JSON válido." });
    }

   
    // --- BLOQUE DATOS FINALES OPTIMIZADO ---NUEVO
    const datosFinales = {
      // 1. Esparcimos primero lo que trajo la IA (nombre_curso, objetivo, etc.)
      ...datosExtraidos,

      // 2. Datos manuales que vienen del frontend (req.body)
      nombre_ejecutor: nombre_organismo,
      rut_ejecutor: rut_organismo,
      telefono_ejecutor: telefono_organismo,
      direccion_ejecutor: direccion_organismo,
      comuna_ejecutor: comuna_organismo,
      region_ejecutor: region_organismo,
      entidad_requirente: req.body.entidad_requirente || "—",
      codigo_curso: req.body.codigo_curso || "—",

      // 3. Aseguramos los campos de la Tabla 3 (Duración)
      // Si el Word usa {horas}, lo mapeamos desde horas_totales
      horas: datosExtraidos.horas_totales || "—",
      dias: datosExtraidos.dias || "—",
      meses: datosExtraidos.meses || "—",



      // 4. Campos de texto largo (asegurar que no sean undefined)
      contenidos: datosExtraidos.contenidos_resumen || "—",
      objetivo_general: datosExtraidos.objetivo_general || "—",
      metodologia: datosExtraidos.metodologia || "—",
      mecanismos_evaluacion: datosExtraidos.mecanismos_evaluacion || "—"
    };
    console.log("✅ Datos extraídos (Ejemplo):", datosExtraidos.nombre_curso);
    
    
    try {
        await new Anexo({
            nombrePlantilla: "plantilla_anexo2.docx",
            datosRellenados: datosFinales,
            fechaGeneracion: new Date(),
            usuarioId: req.user.id, //nuevo campo para relacionar con el usuario
        }).save();
        
        console.log("✅ GUARDADO EXITOSO EN BD");
        res.setHeader("X-Anexo-Guardado", "true");
    } catch (dbError) {
        console.error("❌ ERROR AL GUARDAR EN BD:", dbError);
        res.setHeader("X-Anexo-Guardado", "false"); 
    }
    
    // 👇 AQUÍ ESTÁ EL CAMBIO QUE SOLUCIONA EL ERROR DEL FRONTEND 👇
    res.setHeader("Access-Control-Expose-Headers", "X-Anexo-Guardado, Content-Disposition");
  

    // C. RELLENAR WORD
    const templatePath = path.resolve(
      __dirname,
      "../storage/templates",
      "plantilla_anexo2.docx",
    );
    if (!fs.existsSync(templatePath))
      return res.status(500).json({ error: "Falta plantilla_anexo2.docx" });

    const content = fs.readFileSync(templatePath, "binary");
    const zip = new PizZip(content);

    // Configuración para que los saltos de línea en el JSON se vean en el Word
    const doc = new Docxtemplater(zip, {
        paragraphLoop: true,
        linebreaks: true,
        // ESTO ELIMINA LOS "UNDEFINED" DE TODO EL DOCUMENTO
        nullGetter(part) {
            if (!part.value) {
                return ""; // O puedes dejarlo vacío ""
            }
            return part.value;
        }
    });

    doc.render(datosFinales);
    const buf = doc
      .getZip()
      .generate({ type: "nodebuffer", compression: "DEFLATE" });

    res.setHeader(
      "Content-Disposition",
      "attachment; filename=Anexo_IA_Completo.docx",
    );
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    res.send(buf);

    fs.unlinkSync(req.file.path);
  } catch (error) {
    console.error("❌ Error General:", error);
    res.status(500).json({ error: "Error: " + error.message });
  }
};

// 4. Get a todos los anexos
exports.obtenerAnexos = async (req, res) => {
  try {
    const anexos = await Anexo.find({ usuarioId: req.user.id }).sort({ createdAt: -1 });
    res.status(200).json(anexos);
  } catch (error) {
    console.error("❌ Error obteniendo anexos:", error);
    res.status(500).json({ error: "Error al obtener anexos" });
  }
};

// 5. Get anexo por ID
exports.obtenerAnexoPorId = async (req, res) => {
  try {
    const { id } = req.params;

    const anexo = await Anexo.findOne({
      _id: id,
      usuarioId: req.user.id,
    });

    if (!anexo) {
      return res.status(404).json({ error: "Anexo no encontrado" });
    }

    res.status(200).json(anexo);
  } catch (error) {
    console.error("❌ Error obteniendo anexo:", error);
    res.status(500).json({ error: "Error al obtener el anexo" });
  }
};

// 6. Actualizar Anexo por ID
exports.actualizarAnexo = async (req, res) => {
  try {
    const { id } = req.params;

    const anexoActualizado = await Anexo.findOneAndUpdate(
      { _id: id, usuarioId: req.user.id },
      req.body,
      { new: true }
    );

    if (!anexoActualizado) {
      return res.status(404).json({ error: "Anexo no encontrado" });
    }

    res.status(200).json({
      message: "Anexo actualizado correctamente",
      data: anexoActualizado,
    });
  } catch (error) {
    console.error("❌ Error actualizando anexo:", error);
    res.status(500).json({ error: "Error al actualizar el anexo" });
  }
};

// 7. ELIMINAR ANEXO
exports.eliminarAnexo = async (req, res) => {
  try {
    const { id } = req.params;

    const anexoEliminado = await Anexo.findOneAndDelete({
      _id: id,
      usuarioId: req.user.id,
    });

    if (!anexoEliminado) {
      return res.status(404).json({ error: "Anexo no encontrado" });
    }

    res.status(200).json({
      message: "Anexo eliminado correctamente",
    });
  } catch (error) {
    console.error("❌ Error eliminando anexo:", error);
    res.status(500).json({ error: "Error al eliminar el anexo" });
  }
};