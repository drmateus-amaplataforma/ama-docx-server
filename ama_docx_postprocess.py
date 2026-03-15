#!/usr/bin/env python3
# ama_docx_postprocess.py — Plataforma AMA
# PLACEHOLDER: Substituir pelo arquivo completo do Project Knowledge
# Assinatura: python3 ama_docx_postprocess.py <input.docx> <output.docx>

import sys
import shutil
import os

def main():
    if len(sys.argv) < 3:
        print('[postprocess] Uso: python3 ama_docx_postprocess.py input.docx output.docx')
        sys.exit(1)

    input_docx = sys.argv[1]
    output_docx = sys.argv[2]

    if not os.path.exists(input_docx):
        print('[postprocess] ERRO: arquivo de entrada nao encontrado: ' + input_docx)
        sys.exit(1)

    # PLACEHOLDER: aplicar pos-processamento real aqui
    # Por ora, apenas copiar o arquivo de entrada para saida
    shutil.copy2(input_docx, output_docx)
    print('[postprocess] OK: ' + output_docx)

if __name__ == '__main__':
    main()
