import { decodePDFRawStream, PDFArray, PDFDict, PDFField, PDFForm, PDFHexString, PDFName, PDFRawStream, PDFString } from '@cantoo/pdf-lib';

// Field names such as "topmostSubform[0].Page1[0].f1_01[0]" say nothing to a person.
// A readable label lives in one of two places: the AcroForm tooltip (/TU), which
// most Acrobat-authored forms set, or the XFA template of a hybrid form (IRS and
// other government forms), whose SOM paths match the AcroForm names.

export function tooltip(field: PDFField): string | undefined {
	const tu = field.acroField.dict.lookup(PDFName.of('TU'));
	return tu instanceof PDFString || tu instanceof PDFHexString ? clean(tu.decodeText()) : undefined;
}

export function pageNumbers(form: PDFForm): Map<PDFDict, number> {
	const pages = new Map<PDFDict, number>();
	form.doc.getPages().forEach((page, i) => {
		const annots = page.node.Annots();
		for (let j = 0; annots && j < annots.size(); j++) {
			const annot = annots.lookup(j);
			if (annot instanceof PDFDict) pages.set(annot, i + 1);
		}
	});
	return pages;
}

export type XfaText = { caption?: string; toolTip?: string; speak?: string };

// Maps each XFA field's SOM path to its visible caption, tooltip and screen-reader text.
export function xfaLabels(form: PDFForm): Map<string, XfaText> {
	const labels = new Map<string, XfaText>();
	const xml = xfaTemplate(form);
	if (!xml) return labels;

	// Containers that add a segment to the SOM path. Unnamed ones are transparent.
	const CONTAINERS = new Set(['subform', 'subformSet', 'area', 'exclGroup', 'field']);
	const SOURCES = ['caption', 'toolTip', 'speak'] as const;

	type Frame = { tag: string; segment?: string; counts: Map<string, number>; text?: Record<string, string> };
	const stack: Frame[] = [{ tag: '#root', counts: new Map() }];
	const open: string[] = [];
	const token = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<(\/?)([\w:.-]+)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
	let last = 0;

	for (let m; (m = token.exec(xml)); last = token.lastIndex) {
		const text = xml.slice(last, m.index);
		const labelled = [...stack].reverse().find((f) => f.text);
		if (labelled && text) {
			const source = [...open].reverse().find((t) => (SOURCES as readonly string[]).includes(t));
			if (source) labelled.text![source] = (labelled.text![source] ?? '') + text;
		}
		if (!m[2]) continue;

		const [, closing, tag, attrs, selfClosing] = m;
		if (closing) {
			open.pop();
			if (stack.length > 1 && stack[stack.length - 1].tag === tag) {
				const frame = stack.pop()!;
				if (frame.text && frame.segment) {
					const text: XfaText = {};
					for (const s of SOURCES) {
						const value = clean(decodeEntities(frame.text[s] ?? ''));
						if (value) text[s] = value;
					}
					labels.set(path(stack, frame), text);
				}
			}
			continue;
		}
		if (selfClosing) continue;
		open.push(tag);
		if (!CONTAINERS.has(tag)) continue;

		const name = attrs.match(/\bname="([^"]*)"/)?.[1];
		const frame: Frame = { tag, counts: new Map() };
		if (name) {
			const scope = [...stack].reverse().find((f) => f.segment !== undefined || f.tag === '#root')!;
			const index = scope.counts.get(name) ?? 0;
			scope.counts.set(name, index + 1);
			frame.segment = `${name}[${index}]`;
		}
		if (tag === 'field' || tag === 'exclGroup') frame.text = {};
		stack.push(frame);
	}
	return labels;
}

function path(stack: { segment?: string }[], leaf: { segment?: string }) {
	return [...stack, leaf].map((f) => f.segment).filter(Boolean).join('.');
}

function xfaTemplate(form: PDFForm): string | undefined {
	const xfa = form.acroForm.dict.lookup(PDFName.of('XFA'));
	const decode = (s: unknown) => (s instanceof PDFRawStream ? new TextDecoder().decode(decodePDFRawStream(s).decode()) : undefined);
	if (xfa instanceof PDFRawStream) return decode(xfa);
	if (!(xfa instanceof PDFArray)) return undefined;
	for (let i = 0; i + 1 < xfa.size(); i += 2) {
		const key = xfa.lookup(i);
		if ((key instanceof PDFString || key instanceof PDFHexString) && key.decodeText() === 'template') return decode(xfa.lookup(i + 1));
	}
	return undefined;
}

function decodeEntities(s: string) {
	return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
		if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
		return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e.toLowerCase()]!;
	});
}

function clean(s: string) {
	return s.replace(/\s+/g, ' ').trim();
}
