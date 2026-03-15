#!/usr/bin/env python3
"""
ama_docx_postprocess_v2.py
==========================
Pós-processamento obrigatório para documentos .docx gerados pela Plataforma AMA.
Versão 2 — adiciona correções de diagramação premium identificadas na T26.

Funcionalidades existentes (v1)
--------------------------------
  1. Renumeração de Drawing IDs duplicados
     • <wp:docPr id="..."/>  e  <pic:cNvPr id="..."/>
     • IDs são reatribuídos sequencialmente para garantir unicidade no Word.

  2. Correção de tamanhos de fonte mínimos
     • <w:sz w:val="..."/>  e  <w:szCs w:val="..."/>
     • Qualquer valor < 22 half-points (11pt) é elevado para 22.

Funcionalidades novas (v2)
---------------------------
  3. pageBreakBefore nas seções com tabela de dados
     • Seções alvo: "9. Mapa Metabólico Comparativo" e "10. Zonas de Treinamento"
     • Insere <w:pageBreakBefore/> como primeiro filho do <w:pPr> do parágrafo de título.
     • Ajusta spacing w:before="0" no mesmo parágrafo (o espaçamento visual pré-seção
       é substituído pela quebra de página).

  4. Centralização da tabela da capa
     • Identificador: <w:tblW w:type="dxa" w:w="5000"/>
     • Insere <w:jc w:val="center"/> imediatamente após esse elemento no <w:tblPr>.

  5. cantSplit em todas as linhas de tabela
     • Toda <w:tr> sem <w:trPr>: recebe <w:trPr><w:cantSplit/></w:trPr>.
     • Toda <w:tr> com <w:trPr> mas sem <w:cantSplit/>: insere <w:cantSplit/>
       como primeiro filho do <w:trPr> existente.
     • Nota: cantSplit é Word-only. Aplicar mesmo assim — o arquivo final é
       aberto no Word e a proteção primária contra quebra são os pageBreakBefore.

Uso
---
  python ama_docx_postprocess_v2.py INPUT.docx [OUTPUT.docx]

  Se OUTPUT não for informado, o arquivo original é sobrescrito in-place.

Dependências
------------
  Python 3.8+ (stdlib apenas: zipfile, re, shutil, sys, os, pathlib)
"""

import re
import sys
import os
import shutil
import zipfile
from pathlib import Path


# ─────────────────────────────────────────────────────────────────────────────
# Constantes
# ─────────────────────────────────────────────────────────────────────────────

MIN_FONT_HALF_POINTS = 22           # 11pt × 2 half-points
DOCUMENT_XML_PATH   = "word/document.xml"
WORD_XML_GLOB       = "word/"

# Títulos de seção que devem receber pageBreakBefore
PAGE_BREAK_SECTION_TITLES = [
    "9. Mapa Metab",    # cobre "9. Mapa Metabólico Comparativo" com ou sem acento
    "10. Zonas de Treinamento",
]

# ─── Padrões v1 ───────────────────────────────────────────────────────────────

PATTERN_DOCPR  = re.compile(
    r'(<wp:docPr\b[^>]*\bid=)["\'](\d+)["\']',
    re.IGNORECASE
)
PATTERN_CNVPR  = re.compile(
    r'(<pic:cNvPr\b[^>]*\bid=)["\'](\d+)["\']',
    re.IGNORECASE
)
PATTERN_SZ   = re.compile(r'(<w:sz\s+w:val=)["\'](\d+)["\']',   re.IGNORECASE)
PATTERN_SZCS = re.compile(r'(<w:szCs\s+w:val=)["\'](\d+)["\']', re.IGNORECASE)

# ─── Padrões v2 ───────────────────────────────────────────────────────────────

# Identifica <w:tblW w:type="dxa" w:w="5000"/> — tabela da capa
# Suporta atributos em qualquer ordem dentro da tag
PATTERN_CAPA_TBLW = re.compile(
    r'(<w:tblW\b[^/]*w:type=["\']dxa["\'][^/]*w:w=["\']5000["\'][^/]*/>'
    r'|<w:tblW\b[^/]*w:w=["\']5000["\'][^/]*w:type=["\']dxa["\'][^/]*/>)',
    re.IGNORECASE
)

# Identifica <w:tr> — abertura de linha de tabela (com ou sem atributos)
PATTERN_TR_OPEN = re.compile(r'<w:tr\b[^>]*>', re.IGNORECASE)

# Identifica <w:trPr> já existente dentro de um <w:tr>
PATTERN_TRPR_OPEN = re.compile(r'<w:trPr\b[^>]*>', re.IGNORECASE)

# Detecta <w:cantSplit/> já presente
PATTERN_CANT_SPLIT = re.compile(r'<w:cantSplit\s*/>', re.IGNORECASE)

# spacing w:before — para zerar quando inserimos pageBreakBefore
PATTERN_SPACING_BEFORE = re.compile(
    r'(<w:spacing\b[^>]*\bw:before=)["\'](\d+)["\']',
    re.IGNORECASE
)


# ─────────────────────────────────────────────────────────────────────────────
# Helpers v1
# ─────────────────────────────────────────────────────────────────────────────

def _replace_drawing_ids(xml_content: str) -> tuple[str, int]:
    """Renumera sequencialmente todos os IDs de wp:docPr e pic:cNvPr."""
    counter = [0]

    def _next_id(match) -> str:
        counter[0] += 1
        prefix = match.group(1)
        quote_char = match.group(0)[len(prefix)]
        return f'{prefix}{quote_char}{counter[0]}{quote_char}'

    result, n1 = PATTERN_DOCPR.subn(lambda m: _next_id(m), xml_content)
    result, n2 = PATTERN_CNVPR.subn(lambda m: _next_id(m), result)
    return result, n1 + n2


def _enforce_minimum_font(xml_content: str) -> tuple[str, int]:
    """Garante tamanho mínimo de fonte de MIN_FONT_HALF_POINTS."""
    corrections = [0]

    def _raise_size(match) -> str:
        prefix = match.group(1)
        value  = int(match.group(2))
        quote_char = match.group(0)[len(prefix)]
        if value < MIN_FONT_HALF_POINTS:
            corrections[0] += 1
            return f'{prefix}{quote_char}{MIN_FONT_HALF_POINTS}{quote_char}'
        return match.group(0)

    result = PATTERN_SZ.sub(_raise_size, xml_content)
    result = PATTERN_SZCS.sub(_raise_size, result)
    return result, corrections[0]


# ─────────────────────────────────────────────────────────────────────────────
# Helpers v2 — pageBreakBefore
# ─────────────────────────────────────────────────────────────────────────────

def _find_paragraph_containing_title(xml: str, title_fragment: str) -> tuple[int, int] | None:
    """
    Localiza o parágrafo <w:p>...</w:p> cujo texto contenha title_fragment.
    Retorna (start, end) — índices do parágrafo no xml, ou None se não encontrado.

    Busca pelo fragmento do título dentro de <w:t> dentro de <w:p>.
    Estratégia: encontra a ocorrência de title_fragment em <w:t>, depois
    expande para encontrar o <w:p> pai mais próximo.
    """
    # Procura a ocorrência do fragmento dentro de uma tag <w:t>
    # (pode estar com preservação de espaço: <w:t xml:space="preserve">)
    pattern_wt = re.compile(
        r'<w:t(?:\s[^>]*)?>([^<]*)</w:t>',
        re.IGNORECASE
    )

    for m_wt in pattern_wt.finditer(xml):
        if title_fragment not in m_wt.group(1):
            continue

        # Encontrou. Agora localiza o <w:p> que contém essa posição.
        pos = m_wt.start()

        # Procura o <w:p> mais recente antes de pos
        p_open_iter = list(re.finditer(r'<w:p\b[^>]*>', xml[:pos], re.IGNORECASE))
        if not p_open_iter:
            continue
        p_open = p_open_iter[-1]
        p_start = p_open.start()

        # Procura o </w:p> mais próximo após pos
        p_close = re.search(r'</w:p>', xml[pos:], re.IGNORECASE)
        if not p_close:
            continue
        p_end = pos + p_close.end()

        return p_start, p_end

    return None


def _insert_page_break_before_in_paragraph(para_xml: str) -> tuple[str, bool]:
    """
    Dado o XML de um parágrafo, insere <w:pageBreakBefore/> como primeiro filho
    de <w:pPr> e ajusta spacing w:before="0".

    Retorna (xml_modificado, foi_alterado).
    """
    # Localiza <w:pPr>
    m_ppr = re.search(r'<w:pPr\b[^>]*>', para_xml, re.IGNORECASE)
    if not m_ppr:
        # Não há <w:pPr>. Insere após a abertura de <w:p>
        m_p = re.search(r'<w:p\b[^>]*>', para_xml, re.IGNORECASE)
        if not m_p:
            return para_xml, False
        insert_pos = m_p.end()
        new_xml = (
            para_xml[:insert_pos]
            + '<w:pPr><w:pageBreakBefore/><w:spacing w:before="0"/></w:pPr>'
            + para_xml[insert_pos:]
        )
        return new_xml, True

    ppr_tag_end = m_ppr.end()  # posição após o fechamento da tag de abertura <w:pPr>

    # Verifica se pageBreakBefore já existe
    # Procura o fechamento </w:pPr> para delimitar o escopo
    m_ppr_close = re.search(r'</w:pPr>', para_xml[ppr_tag_end:], re.IGNORECASE)
    if not m_ppr_close:
        return para_xml, False
    ppr_content_end = ppr_tag_end + m_ppr_close.start()
    ppr_content = para_xml[ppr_tag_end:ppr_content_end]

    already_has_pbr = bool(re.search(r'<w:pageBreakBefore\b', ppr_content, re.IGNORECASE))
    if already_has_pbr:
        # Garante apenas o zeroing do spacing w:before se necessário
        modified = para_xml
        modified_ppr_region = modified[ppr_tag_end:ppr_content_end]
        new_ppr_region, n = PATTERN_SPACING_BEFORE.subn(
            lambda m: m.group(1) + '"0"',
            modified_ppr_region
        )
        if n > 0:
            modified = modified[:ppr_tag_end] + new_ppr_region + modified[ppr_content_end:]
            return modified, True
        return para_xml, False

    # Insere <w:pageBreakBefore/> como PRIMEIRO filho de <w:pPr>
    new_xml = (
        para_xml[:ppr_tag_end]
        + '<w:pageBreakBefore/>'
        + para_xml[ppr_tag_end:]
    )

    # Recalcula posições após a inserção
    pbr_len = len('<w:pageBreakBefore/>')
    new_ppr_content_end = ppr_content_end + pbr_len

    # Zera spacing w:before dentro do <w:pPr>
    ppr_content_new = new_xml[ppr_tag_end:new_ppr_content_end]
    ppr_content_new, _ = PATTERN_SPACING_BEFORE.subn(
        lambda m: m.group(1) + '"0"',
        ppr_content_new
    )
    new_xml = new_xml[:ppr_tag_end] + ppr_content_new + new_xml[new_ppr_content_end:]

    return new_xml, True


def _apply_page_breaks(xml: str, section_titles: list[str]) -> tuple[str, int]:
    """
    Localiza os parágrafos de título de cada seção em section_titles e insere
    pageBreakBefore. Retorna (xml_modificado, contagem_de_seções_alteradas).
    """
    count = 0
    for title_fragment in section_titles:
        result = _find_paragraph_containing_title(xml, title_fragment)
        if result is None:
            continue
        p_start, p_end = result
        para_xml = xml[p_start:p_end]
        new_para, changed = _insert_page_break_before_in_paragraph(para_xml)
        if changed:
            xml = xml[:p_start] + new_para + xml[p_end:]
            count += 1
    return xml, count


# ─────────────────────────────────────────────────────────────────────────────
# Helpers v2 — centralização tabela da capa
# ─────────────────────────────────────────────────────────────────────────────

def _center_capa_table(xml: str) -> tuple[str, int]:
    """
    Localiza <w:tblW w:type="dxa" w:w="5000"/> e insere <w:jc w:val="center"/>
    imediatamente após, dentro do <w:tblPr>.

    Retorna (xml_modificado, número_de_ocorrências_alteradas).
    """
    count = [0]

    def _replace(m):
        tblw_tag = m.group(0)
        # Verifica se <w:jc w:val="center"/> já existe logo após (evita duplicatas)
        after = xml[m.end():m.end() + 60]
        if re.search(r'<w:jc\b[^>]*w:val=["\']center["\']', after, re.IGNORECASE):
            return tblw_tag   # já centralizado, sem alteração
        count[0] += 1
        return tblw_tag + '<w:jc w:val="center"/>'

    result = PATTERN_CAPA_TBLW.sub(_replace, xml)
    return result, count[0]


# ─────────────────────────────────────────────────────────────────────────────
# Helpers v2 — cantSplit
# ─────────────────────────────────────────────────────────────────────────────

def _apply_cant_split(xml: str) -> tuple[str, int]:
    """
    Percorre todas as ocorrências de <w:tr ...> e garante que o <w:trPr>
    interno contenha <w:cantSplit/>.

    Casos tratados:
      A) <w:tr> sem <w:trPr>: insere <w:trPr><w:cantSplit/></w:trPr> imediatamente
         após a tag de abertura <w:tr ...>.
      B) <w:tr> com <w:trPr> sem <w:cantSplit/>: insere <w:cantSplit/> como
         primeiro filho do <w:trPr> existente.
      C) <w:tr> com <w:trPr> que já tem <w:cantSplit/>: sem alteração.

    Retorna (xml_modificado, contagem_de_linhas_alteradas).
    """
    count = 0
    result_parts = []
    cursor = 0

    for m_tr in PATTERN_TR_OPEN.finditer(xml):
        tr_tag_start = m_tr.start()
        tr_tag_end   = m_tr.end()

        # Adiciona tudo antes desta <w:tr>
        result_parts.append(xml[cursor:tr_tag_end])
        cursor = tr_tag_end

        # Agora precisamos inspecionar o conteúdo do <w:tr>
        # Encontra o </w:tr> correspondente (não aninhado, pois tabelas não se aninham
        # dentro de <w:tr> no OOXML padrão)
        tr_close = xml.find('</w:tr>', tr_tag_end)
        if tr_close == -1:
            # Não encontrou fechamento — segurança: continua sem alterar
            continue

        tr_body = xml[tr_tag_end:tr_close]  # conteúdo entre <w:tr> e </w:tr>

        # Caso A: sem <w:trPr>
        if not re.search(r'<w:trPr\b', tr_body, re.IGNORECASE):
            result_parts.append('<w:trPr><w:cantSplit/></w:trPr>')
            count += 1
            result_parts.append(tr_body)
            result_parts.append('</w:tr>')
            cursor = tr_close + len('</w:tr>')
            continue

        # Caso B ou C: tem <w:trPr>
        m_trpr = PATTERN_TRPR_OPEN.search(tr_body)
        if m_trpr:
            # Extrai conteúdo interno do <w:trPr>
            trpr_tag_end_in_body = m_trpr.end()
            trpr_close_in_body   = tr_body.find('</w:trPr>', trpr_tag_end_in_body)
            if trpr_close_in_body != -1:
                trpr_inner = tr_body[trpr_tag_end_in_body:trpr_close_in_body]
                if not PATTERN_CANT_SPLIT.search(trpr_inner):
                    # Caso B: insere <w:cantSplit/> como primeiro filho
                    new_trpr_inner = '<w:cantSplit/>' + trpr_inner
                    tr_body = (
                        tr_body[:trpr_tag_end_in_body]
                        + new_trpr_inner
                        + tr_body[trpr_close_in_body:]
                    )
                    count += 1
                # Caso C: já tem <w:cantSplit/>, sem alteração

        result_parts.append(tr_body)
        result_parts.append('</w:tr>')
        cursor = tr_close + len('</w:tr>')

    # Adiciona o restante do documento após o último </w:tr>
    result_parts.append(xml[cursor:])
    return ''.join(result_parts), count


# ─────────────────────────────────────────────────────────────────────────────
# Processamento principal
# ─────────────────────────────────────────────────────────────────────────────

def postprocess_docx(input_path: str, output_path: str | None = None) -> dict:
    """
    Executa o pós-processamento completo em um arquivo .docx.

    Parâmetros
    ----------
    input_path  : caminho do .docx de entrada
    output_path : caminho de saída (None = sobrescrever input)

    Retorna um dicionário com estatísticas do processamento.
    """
    input_path  = Path(input_path).resolve()
    output_path = Path(output_path).resolve() if output_path else input_path

    if not input_path.exists():
        raise FileNotFoundError(f"Arquivo não encontrado: {input_path}")

    tmp_path = input_path.with_suffix(".tmp.docx")
    shutil.copy2(input_path, tmp_path)

    stats = {
        "input":               str(input_path),
        "output":              str(output_path),
        "drawing_ids_fixed":   0,
        "font_corrections":    0,
        "page_breaks_added":   0,
        "capa_table_centered": 0,
        "cant_split_added":    0,
        "files_processed":     0,
    }

    try:
        with zipfile.ZipFile(input_path, "r") as zin:
            names    = zin.namelist()
            contents = {name: zin.read(name) for name in names}

        # ── Passo 1: Renumerar IDs de drawing em word/document.xml ──────────
        doc_xml_bytes = contents.get(DOCUMENT_XML_PATH)
        if doc_xml_bytes is None:
            raise ValueError(f"'{DOCUMENT_XML_PATH}' não encontrado no .docx.")

        doc_xml_str = doc_xml_bytes.decode("utf-8")
        doc_xml_str, id_count = _replace_drawing_ids(doc_xml_str)
        stats["drawing_ids_fixed"] += id_count
        stats["files_processed"]   += 1

        # ── Passo 2: pageBreakBefore nas seções 9 e 10 ──────────────────────
        doc_xml_str, pb_count = _apply_page_breaks(doc_xml_str, PAGE_BREAK_SECTION_TITLES)
        stats["page_breaks_added"] += pb_count

        # ── Passo 3: Centralizar tabela da capa ─────────────────────────────
        doc_xml_str, capa_count = _center_capa_table(doc_xml_str)
        stats["capa_table_centered"] += capa_count

        # ── Passo 4: cantSplit em todas as linhas de tabela ──────────────────
        doc_xml_str, cs_count = _apply_cant_split(doc_xml_str)
        stats["cant_split_added"] += cs_count

        contents[DOCUMENT_XML_PATH] = doc_xml_str.encode("utf-8")

        # ── Passo 5: Enforçar fonte mínima em TODOS os XMLs de word/ ────────
        for name in names:
            if not name.startswith(WORD_XML_GLOB):
                continue
            if not name.endswith(".xml"):
                continue

            raw = contents[name].decode("utf-8", errors="replace")
            modified, corrections = _enforce_minimum_font(raw)

            if corrections > 0:
                contents[name] = modified.encode("utf-8")
                stats["font_corrections"] += corrections
                stats["files_processed"]  += 1

        # Garante que document.xml seja atualizado mesmo sem correções de fonte
        # (foi modificado nos passos 1–4)
        contents[DOCUMENT_XML_PATH] = doc_xml_str.encode("utf-8")

        # ── Escreve o .docx resultante ───────────────────────────────────────
        with zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_DEFLATED) as zout:
            for name, data in contents.items():
                zout.writestr(name, data)

        shutil.move(str(tmp_path), str(output_path))

    except Exception:
        if tmp_path.exists():
            tmp_path.unlink()
        raise

    return stats


# ─────────────────────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────────────────────

def main():
    if len(sys.argv) < 2:
        print(__doc__)
        print("\nUso: python ama_docx_postprocess_v2.py INPUT.docx [OUTPUT.docx]")
        sys.exit(1)

    input_path  = sys.argv[1]
    output_path = sys.argv[2] if len(sys.argv) >= 3 else None

    print(f"\n{'═'*62}")
    print("  AMA DOCX Post-Processor v2 — Plataforma AMA / Oxy Recovery")
    print(f"{'═'*62}")
    print(f"  Entrada : {input_path}")
    print(f"  Saída   : {output_path or '(sobrescrever original)'}")
    print(f"{'─'*62}")

    try:
        stats = postprocess_docx(input_path, output_path)
    except FileNotFoundError as e:
        print(f"\n  ❌ ERRO: {e}")
        sys.exit(2)
    except Exception as e:
        print(f"\n  ❌ ERRO inesperado: {e}")
        raise

    print(f"  ✅ Drawing IDs renumerados    : {stats['drawing_ids_fixed']}")
    print(f"  ✅ Correções de fonte         : {stats['font_corrections']}")
    print(f"  ✅ pageBreakBefore aplicado   : {stats['page_breaks_added']} seções")
    print(f"  ✅ Tabela capa centralizada   : {stats['capa_table_centered']}")
    print(f"  ✅ cantSplit adicionado        : {stats['cant_split_added']} linhas")
    print(f"  ✅ Arquivos XML tocados        : {stats['files_processed']}")
    print(f"  ✅ Saída gravada em            : {stats['output']}")
    print(f"{'═'*62}\n")

    if stats["drawing_ids_fixed"] == 0:
        print("  ℹ️  Nenhum ID de drawing encontrado — verifique se o .docx contém imagens.")
    if stats["page_breaks_added"] == 0:
        print("  ⚠️  pageBreakBefore: nenhuma seção alvo localizada. Verifique os títulos das seções 9 e 10.")
    if stats["capa_table_centered"] == 0:
        print("  ⚠️  Tabela da capa não encontrada (tblW w:w=5000). Verifique se o documento possui capa.")
    if stats["cant_split_added"] == 0:
        print("  ℹ️  cantSplit: nenhuma linha de tabela sem proteção encontrada.")


if __name__ == "__main__":
    main()
