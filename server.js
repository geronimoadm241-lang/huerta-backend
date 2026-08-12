
// PDFs FACTURAS - upload individual
app.post('/api/pdfs/factura', upload.single('file'), async (req, res) => {
  try {
    const fileBuffer = req.file.buffer;
    const fileName = req.file.originalname;
    const publicId = fileName.replace('.pdf', '');
    const result = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        { resource_type: 'raw', folder: 'huerta-facturas', public_id: publicId, overwrite: true },
        (err, res) => err ? reject(err) : resolve(res)
      ).end(fileBuffer);
    });
    await pool.query(
      `UPDATE facturas SET pdf_url=$1 WHERE referencia=$2 OR pdf=$3 OR pdf=$4`,
      [result.secure_url, publicId, fileName, publicId]
    );
    res.json({ ok: true, url: result.secure_url, nombre: fileName });
  } catch (e) { res.status(500).json({ error: e.message }) }
});

app.get('/api/pdfs/facturas', async (req, res) => {
  try {
    const r = await pool.query("SELECT referencia, pdf, pdf_url FROM facturas WHERE pdf_url IS NOT NULL AND pdf_url != ''");
    const out = {};
    r.rows.forEach(row => {
      if(row.referencia) out[row.referencia] = row.pdf_url;
      if(row.pdf) out[row.pdf.replace('.pdf','')] = row.pdf_url;
    });
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }) }
});

const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, () => console.log(`Huerta backend running on port ${PORT}`));
}).catch(console.error);
