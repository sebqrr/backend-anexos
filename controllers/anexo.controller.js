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

    // --- AQUÍ ESTÁ LA MAGIA: EL PROMPT GIGANTE ---
    const prompt = `
      Actúa como un experto técnico en licitaciones SENCE y OTIC de Chile. 
      Tu tarea es extraer TODA la información técnica posible de este texto (proveniente de unas Bases Técnicas o Descriptor de Oficio) para rellenar un Anexo Técnico completo.

      Texto a analizar:
      "${textoCompleto.substring(0, 70000)}" 
      
      Instrucciones Críticas:
      1. Devuelve SOLO un objeto JSON válido.
      2. Si un dato no aparece explícitamente, infiérelo del contexto o pon "Según estándar SENCE" o "A definir por el ejecutor", pero NO lo dejes vacío.
      3. OJO: Para "lista_equipos" y "lista_materiales" DEBES devolver un ARRAY de objetos.
      4. NO incluyas comentarios fuera del JSON.
      5. NO uses null ni undefined.

      =========== REGLAS DE ORO PARA "lista_equipos" (Sigue esto al pie de la letra) ===========
      
      A. CRITERIO DE INCLUSIÓN:
         - Incluye todo equipo físico necesario para la ejecución práctica (Soldadoras, Esmeriles, Taladros, Prensas, etc.).
         - Incluye también "Set de escritorio", "Proyector" y "Notebook/PC" si el texto los menciona.
         - NO incluyas instrumentos puramente teóricos de medición (Micrómetro, Pie de metro) como 'equipos', salvo que sean máquinas grandes.

      B. CRITERIO DE MÓDULOS (Multi-módulo):
         - Si un equipo se utiliza en varios módulos, en el campo "modulo" DEBES listarlos todos separados por comas (Ej: "Módulo 1, Módulo 3").
         - NO elijas solo uno si aplica a varios. Si aplica a todo el curso, pon "Transversal".

      C. CRITERIO DE PARTICIPANTES (Números, no texto):
         - En el campo "num_participantes", NUNCA pongas "Uso del facilitador" ni textos descriptivos. DEBE SER UN NÚMERO.
         - Si el equipo es individual por alumno: pon "1".
         - Si el equipo es compartido por grupos: pon el tamaño del grupo (Ej: "5").
         - Si el equipo es ÚNICO para la sala (Ej: Proyector, Pizarra, PC del Profesor, Extintor): pon el TOTAL de alumnos del curso (Ej: "20" o "25").

      D. CRITERIO DE CERTIFICACIÓN (SEC):
         - En el campo "certificacion": Analiza si el equipo es ELÉCTRICO (se enchufa a la corriente o usa carga eléctrica).
         - Si es ELÉCTRICO (Ej: Soldadora, Taladro, Esmeril, Proyector, Notebook, Alargador): Pon "SEC".
         - Si es MANUAL o inerte (Ej: Martillo, Alicate, Mesa, Pizarra): Pon "No aplica".
         - NUNCA dejes este campo vacío.

      E. CRITERIO DE CANTIDAD:
         - La "cantidad" debe ser coherente con el número de alumnos. Si es individual y son 20 alumnos, pon "20".
      ========================================================================================

      Estructura JSON requerida (Usa estas claves exactas):
      {
        "nombre_curso": "Nombre completo del oficio o curso",
        "horas_totales": "Duración total en horas",
        "modalidad": "Presencial, E-learning o Blended",
        
        "objetivo_general": "Texto completo del objetivo",
        "objetivos_especificos": "Lista de objetivos específicos",
        
        "contenidos_resumen": "Resumen de los módulos",
        "numero_participantes": "Cantidad de alumnos (si no sale explícito, pon '20')",
        
        "requisitos_ingreso": "Perfil de los postulantes",
        "perfil_facilitador": "Experiencia y requisitos",
        
        "infraestructura_sala": "Descripción de la sala",
        "infraestructura_taller": "Descripción del taller",
        "infraestructura_banos": "Requisitos de baños",
        
        "lista_equipos": [
            {
                "descripcion": "Nombre específico del equipo (Ej: Soldadora Arco Manual)",
                "modulo": "Ej: 'Módulo 1, Módulo 2' o 'Transversal'",
                "cantidad": "Número total (Ej: 20)",
                "num_participantes": "Número (Ej: 1, 5, o 20)",
                "antiguedad": "Menos de 2 años",
                "certificacion": "SEC o No aplica"
            }
        ],
        
        "equipamiento_seguridad": "EPP necesarios",
        
        "lista_materiales": [
          {
            "descripcion": "Material consumible",
            "unidad": "Kilos, metros, unidades",
            "cantidad": "Cantidad total",
            "modulo": "Módulo donde se utiliza",
            "num_participantes": "Ej: 1"
          }
        ],

        "materiales_escritorio": "Lápices, cuadernos, carpetas",
        "metodologia": "Descripción metodología",
        "mecanismos_evaluacion": "Pruebas, listas de cotejo"
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

    const datosFinales = {
      // =====================
      // DATOS MANUALES
      // =====================
      nombre_ejecutor: nombre_organismo,
      rut_ejecutor: rut_organismo,
      telefono_ejecutor: telefono_organismo,
      direccion_ejecutor: direccion_organismo,
      comuna_ejecutor: comuna_organismo,
      region_ejecutor: region_organismo,

      entidad_requirente: req.body.entidad_requirente || "—",

      // =====================
      // DATOS CURSO (MANUAL O IA)
      // =====================
      codigo_curso: req.body.codigo_curso || "—",
      horas: datosExtraidos.horas_totales || "—",

      // =====================
      // DATOS IA
      // =====================
      contenidos: datosExtraidos.contenidos_resumen,
      objetivo_general: datosExtraidos.objetivo_general,

      // IA
      ...datosExtraidos,
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
    
    res.setHeader("Access-Control-Expose-Headers", "X-Anexo-Guardado");
  

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