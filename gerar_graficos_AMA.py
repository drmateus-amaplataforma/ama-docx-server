#!/usr/bin/env python3
# gerar_graficos_AMA.py — Plataforma AMA
# PLACEHOLDER: Substituir pelo arquivo completo do Project Knowledge
# Este arquivo deve gerar os 5 graficos PNG da avaliacao AMA:
# G1_mapa_metabolico_v4.png
# G2_resposta_cardiaca_v4.png
# G3_equivalentes_ventilatorios_v4.png
# G4_rer_v4.png
# G5_fatmax_v4.png
# Saida: /mnt/user-data/outputs/ (sera patchado pelo server.js para /tmp/ama-jobs/<jobId>/graficos/)

import sys
import json
import os
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

def main():
    input_file = sys.argv[1] if len(sys.argv) > 1 else None
    dados = {}
    if input_file and os.path.exists(input_file):
        with open(input_file, 'r') as f:
            dados = json.load(f)

    output_dir = '/mnt/user-data/outputs/'
    os.makedirs(output_dir, exist_ok=True)

    graficos = [
        'G1_mapa_metabolico_v4.png',
        'G2_resposta_cardiaca_v4.png',
        'G3_equivalentes_ventilatorios_v4.png',
        'G4_rer_v4.png',
        'G5_fatmax_v4.png',
    ]

    for nome in graficos:
        fig, ax = plt.subplots(figsize=(8, 5))
        ax.text(0.5, 0.5, nome.replace('.png','').replace('_',' '),
                ha='center', va='center', fontsize=14)
        ax.set_title('AMA — Plataforma AMA')
        ax.axis('off')
        fig.savefig(os.path.join(output_dir, nome), dpi=150, bbox_inches='tight')
        plt.close(fig)
        print(f'[graficos] {nome} OK')

if __name__ == '__main__':
    main()
