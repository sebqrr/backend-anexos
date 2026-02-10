// backend/models/Anexo.js
const mongoose = require("mongoose");

const AnexoSchema = new mongoose.Schema({
  nombrePlantilla: {
    type: String,
    required: true,
  },
  datosRellenados: {
    type: Object, // Guardamos el JSON completo que envió el usuario
    required: true,
  },
  fechaGeneracion: {
    type: Date,
    default: Date.now,
  },
  // En el futuro, aquí guardarás el ID del usuario que lo creó
  // usuarioId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
});

module.exports = mongoose.model("Anexo", AnexoSchema);
