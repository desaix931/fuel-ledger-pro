'use strict';
// Downloadable company forms for drivers (public, no login).
// The office drops its own NDA PDF at public/forms/desaix-nda.pdf; until that
// file exists this route 404s and the /hire/thanks page hides the NDA
// download button (it checks ndaFileExists()).
const fs = require('fs');
const path = require('path');
const express = require('express');

const router = express.Router();

const NDA_PATH = path.join(__dirname, '..', '..', 'public', 'forms', 'desaix-nda.pdf');

function ndaFileExists() {
  try { return fs.existsSync(NDA_PATH); } catch { return false; }
}

router.get('/nda', (req, res) => {
  if (!ndaFileExists()) {
    return res.status(404).send('The company NDA form is not available for download yet — the office will provide it.');
  }
  res.download(NDA_PATH, 'DeSaix-NDA.pdf');
});

module.exports = router;
module.exports.ndaFileExists = ndaFileExists;
module.exports.NDA_PATH = NDA_PATH;
