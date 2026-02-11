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
    Tu misión es extraer información técnica completa y coherente para el "Anexo N° 2".

      Texto a analizar:
      "${textoCompleto.substring(0, 70000)}"

    ================ REGLAS OBLIGATORIAS =================

    1. NINGUNA FILA INCOMPLETA (CRÍTICO):
      - Cada objeto dentro de "lista_equipos" y "lista_materiales" DEBE tener TODOS sus campos completos.
      - No se permiten valores como:
          "— —"
          "-"
          ""
      - Si no hay información explícita, debes inferir un valor técnico coherente.
      - NUNCA dejes campos vacíos.

    2. FORMATO DE EQUIPOS (TABLA 7):
      - "cantidad" = solo número.
      - "unidad_medida" = solo tipo (Unidades, Sets, Global, etc.).
      - "num_participantes" debe ser coherente:
          Ejemplo:
            Si hay 15 computadores → num_participantes = "1"
            Si hay 1 proyector para 15 personas → num_participantes = "15"
      - "antiguedad" nunca puede ir vacía → usar "Menos de 2 años".
      - "certificacion":
            - Equipos eléctricos → "Cert. SEC"
            - Otros → "No aplica"

    3. ÍTEMS OBLIGATORIOS EN EQUIPOS:
      Siempre deben existir:
      - "Equipo de seguridad individual"
      - "Kit de herramientas"

      Para estos:
      - cantidad: "15"
      - unidad_medida: "Unidades"
      - num_participantes: "1"
      - antiguedad: "Menos de 2 años"
      - certificacion: "No aplica"

    4. FORMATO DE MATERIALES (TABLA 8):
      - "cantidad" debe venir combinado:
          Ej: "15 Unidades", "1 Set"
      - NUNCA solo número.
      - "num_participantes" NUNCA puede ir vacío.
      - Regla lógica:
          - Si es material individual → num_participantes = "1"
          - Si es material compartido → num_participantes = "15"

    5. CERO NULL:
      - Nunca enviar null.
      - Nunca enviar undefined.
      - Nunca enviar campos vacíos.
      - Si no existe información → inferir valor razonable.

    6. DURACIÓN:
      - Extraer "horas_totales", "dias" y "meses".

    ======================================================
    ESTRUCTURA JSON EXACTA:

    {
      "nombre_curso": "...",
      "horas_totales": "...",
      "dias": "...",
      "meses": "...",
      "lista_equipos": [
        {
          "descripcion": "...",
          "modulo": "1, 2, 3, 4, 5",
          "cantidad": "15",
          "unidad_medida": "Unidades",
          "num_participantes": "1",
          "antiguedad": "Menos de 2 años",
          "certificacion": "Cert. SEC"
        }
      ],
      "lista_materiales": [
        {
          "descripcion": "...",
          "cantidad": "15 Unidades",
          "modulo": "1, 2, 3, 4, 5",
          "num_participantes": "1"
        }
      ],
      "objetivo_general": "...",
      "contenidos_resumen": "...",
      "infraestructura_sala": "...",
      "infraestructura_taller": "...",
      "metodologia": "...",
      "mecanismos_evaluacion": "..."
    }
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

      // 4. Limpieza de Materiales (Tabla 8) - CORREGIDO FORMATO SENCE
      lista_materiales: (datosExtraidos.lista_materiales || []).map(m => ({
        descripcion: m.descripcion || "—",
        modulo: m.modulo || "—",
        num_participantes: m.num_participantes || "—",
        cantidad: m.cantidad || "1 Unidades"
      })),


      // 5. Limpieza de Equipos (Tabla 7)
      lista_equipos: (datosExtraidos.lista_equipos || []).map(e => ({
        descripcion: e.descripcion || "—",
        modulo: e.modulo || "—",
        num_participantes: e.num_participantes || "20",
        antiguedad: e.antiguedad || "Menos de 2 años",
        certificacion: e.certificacion || "No aplica",
        // Combinamos cantidad y unidad igual que en materiales
        cantidad: `${e.cantidad || "1"} ${e.unidad_medida || "Unidad"}`.trim()
      })),

      // 6. Campos de texto largo (asegurar que no sean undefined)
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
            fechaGeneracion: new Date()
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
    const anexos = await Anexo.find().sort({ createdAt: -1 });
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

    const anexo = await Anexo.findById(id);

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

    const anexoActualizado = await Anexo.findByIdAndUpdate(id, req.body, {
      new: true,
    });

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

    const anexoEliminado = await Anexo.findByIdAndDelete(id);

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