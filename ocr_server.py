"""
Servidor OCR local — PaddleOCR 2.x + PyMuPDF.
Iniciado automaticamente pelo Node.js (server.js) ao subir a aplicação.

Instalação das dependências (uma vez):
    pip install -r requirements.txt
"""
import sys
import threading
import numpy as np
from flask import Flask, request, jsonify

app = Flask(__name__)

# PaddleOCR carregado uma vez — lock garante acesso serial (não é thread-safe)
_ocr = None
_lock = threading.Lock()


def _init():
    global _ocr
    from paddleocr import PaddleOCR  # import tardio: evita custo se nunca usado
    _ocr = PaddleOCR(use_angle_cls=False, lang='pt', show_log=False)
    print('[ocr_server] Modelo PaddleOCR carregado. Aguardando requisições.', flush=True)


@app.route('/health')
def health():
    return jsonify({'ok': True})


@app.route('/ocr', methods=['POST'])
def ocr():
    if 'file' not in request.files:
        return jsonify({'error': 'campo file ausente'}), 400

    try:
        import fitz  # PyMuPDF

        pdf_bytes = request.files['file'].read()
        doc = fitz.open(stream=pdf_bytes, filetype='pdf')

        all_lines = []
        # Processa no máximo 3 páginas (mesmo limite do Tesseract.js anterior)
        with _lock:
            for page_num in range(min(doc.page_count, 3)):
                page = doc[page_num]
                # 150 DPI — suficiente para documentos impressos/digitais
                mat = fitz.Matrix(150 / 72, 150 / 72)
                pix = page.get_pixmap(matrix=mat)

                # PyMuPDF → numpy array RGB
                img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(
                    pix.height, pix.width, pix.n
                )
                if pix.n == 4:          # RGBA → RGB (descarta canal alpha)
                    img = img[:, :, :3]

                # PaddleOCR 2.x: ocr() retorna [[[box, (text, score)], ...]]
                result = _ocr.ocr(img, cls=False)
                if not result:
                    continue
                for page_result in result:
                    if not page_result:
                        continue
                    for line in page_result:
                        # line = [box, (text, score)]
                        if line and len(line) >= 2 and line[1]:
                            text = line[1][0]
                            if text:
                                all_lines.append(text)

        return jsonify({'text': ' '.join(all_lines)})

    except Exception as exc:
        return jsonify({'error': str(exc)}), 500


if __name__ == '__main__':
    print('[ocr_server] Carregando PaddleOCR (aguarde ~5–10 s)…', flush=True)
    _init()
    app.run(host='127.0.0.1', port=5001, threaded=True, debug=False)
