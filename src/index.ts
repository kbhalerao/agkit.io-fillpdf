import {
	PDFCheckBox,
	PDFDocument,
	PDFDropdown,
	PDFField,
	PDFForm,
	PDFOptionList,
	PDFRadioGroup,
	PDFSignature,
	PDFTextField,
} from '@cantoo/pdf-lib';
import { pageNumbers, tooltip, xfaLabels } from './labels';

const MAX_PDF_BYTES = 20 * 1024 * 1024;

class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
		readonly details?: unknown,
	) {
		super(message);
	}
}

export default {
	async fetch(request: Request): Promise<Response> {
		try {
			const { pathname } = new URL(request.url);
			if (pathname !== '/fields' && pathname !== '/fill') throw new HttpError(404, 'Use POST /fields or POST /fill');
			if (request.method !== 'POST') throw new HttpError(405, 'Method must be POST');

			const input = await readInput(request);
			const form = await loadForm(input.pdf);

			if (pathname === '/fields') {
				const labels = xfaLabels(form);
				const pages = pageNumbers(form);
				const fields = form.getFields().map((field) => {
					const xfa = labels.get(field.getName()) ?? {};
					// label: the short text printed by the field. description: the longer
					// screen-reader text, which often carries the question a Yes/No box answers.
					const label = tooltip(field) ?? xfa.caption ?? xfa.toolTip ?? xfa.speak ?? null;
					const description = xfa.speak ?? xfa.toolTip ?? null;
					return {
						name: field.getName(),
						label,
						description: description === label ? null : description,
						page: pages.get(field.acroField.getWidgets()[0]?.dict) ?? null,
						...describe(field),
					};
				});
				return Response.json({ xfa: form.hasXFA(), fields });
			}

			if (!input.data) throw new HttpError(400, 'Missing "data": an object of field name to value');
			fill(form, input.data);
			const bytes = await form.doc.save();
			return new Response(bytes, {
				headers: { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="filled.pdf"' },
			});
		} catch (e) {
			if (e instanceof HttpError) return Response.json({ error: e.message, details: e.details }, { status: e.status });
			return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
		}
	},
};

interface Input {
	pdf: ArrayBuffer;
	data?: Record<string, unknown>;
}

// multipart/form-data: `file` or `url`, plus `data` as a JSON string.
// application/json: { url, data }.
async function readInput(request: Request): Promise<Input> {
	const type = request.headers.get('content-type') ?? '';
	let file: File | null = null;
	let url: unknown;
	let data: unknown;

	if (type.startsWith('multipart/form-data')) {
		const form = await request.formData();
		const f = form.get('file');
		file = f instanceof File ? f : null;
		url = form.get('url') ?? undefined;
		const raw = form.get('data');
		if (typeof raw === 'string') {
			try {
				data = JSON.parse(raw);
			} catch {
				throw new HttpError(400, '"data" is not valid JSON');
			}
		}
	} else if (type.startsWith('application/json')) {
		const body = (await request.json().catch(() => {
			throw new HttpError(400, 'Body is not valid JSON');
		})) as Record<string, unknown>;
		url = body?.url;
		data = body?.data;
	} else {
		throw new HttpError(415, 'Content-Type must be multipart/form-data or application/json');
	}

	if (data !== undefined && (typeof data !== 'object' || data === null || Array.isArray(data))) {
		throw new HttpError(400, '"data" must be an object of field name to value');
	}

	let pdf: ArrayBuffer;
	if (file) {
		if (file.size > MAX_PDF_BYTES) throw new HttpError(413, `PDF exceeds ${MAX_PDF_BYTES} bytes`);
		pdf = await file.arrayBuffer();
	} else if (typeof url === 'string' && url) {
		pdf = await download(url);
	} else {
		throw new HttpError(400, 'Send a PDF as "file" or a link to one as "url"');
	}
	return { pdf, data: data as Record<string, unknown> | undefined };
}

async function download(url: string): Promise<ArrayBuffer> {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new HttpError(400, '"url" is not a valid URL');
	}
	if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new HttpError(400, '"url" must be http or https');

	const res = await fetch(parsed, { redirect: 'follow' });
	if (!res.ok) throw new HttpError(502, `Fetching the PDF returned HTTP ${res.status}`);
	if (Number(res.headers.get('content-length') ?? 0) > MAX_PDF_BYTES) {
		throw new HttpError(413, `PDF exceeds ${MAX_PDF_BYTES} bytes`);
	}
	const bytes = await res.arrayBuffer();
	if (bytes.byteLength > MAX_PDF_BYTES) throw new HttpError(413, `PDF exceeds ${MAX_PDF_BYTES} bytes`);
	return bytes;
}

async function loadForm(pdf: ArrayBuffer): Promise<PDFForm> {
	let doc: PDFDocument;
	try {
		// Keep XFA so /fields can report it and read its labels; /fill removes it.
		doc = await PDFDocument.load(pdf, { preserveXFA: true });
	} catch (e) {
		throw new HttpError(400, `Cannot read the PDF: ${e instanceof Error ? e.message : e}`);
	}
	return doc.getForm();
}

type FieldType = 'text' | 'checkbox' | 'radio' | 'dropdown' | 'optionlist' | 'signature' | 'button';

function typeOf(field: PDFField): FieldType {
	if (field instanceof PDFTextField) return 'text';
	if (field instanceof PDFCheckBox) return 'checkbox';
	if (field instanceof PDFRadioGroup) return 'radio';
	if (field instanceof PDFDropdown) return 'dropdown';
	if (field instanceof PDFOptionList) return 'optionlist';
	if (field instanceof PDFSignature) return 'signature';
	return 'button';
}

function describe(field: PDFField) {
	const base = { type: typeOf(field), required: field.isRequired(), readOnly: field.isReadOnly() };
	if (field instanceof PDFTextField) {
		return { ...base, value: field.getText() ?? null, maxLength: field.getMaxLength() ?? null, multiline: field.isMultiline() };
	}
	if (field instanceof PDFCheckBox) return { ...base, value: field.isChecked() };
	if (field instanceof PDFRadioGroup) return { ...base, value: field.getSelected() ?? null, options: field.getOptions() };
	if (field instanceof PDFDropdown) {
		return { ...base, value: field.getSelected(), options: field.getOptions(), multiselect: field.isMultiselect(), editable: field.isEditable() };
	}
	if (field instanceof PDFOptionList) {
		return { ...base, value: field.getSelected(), options: field.getOptions(), multiselect: field.isMultiselect() };
	}
	return base;
}

// Validates every entry first and applies nothing unless all of them pass,
// so a caller sees every problem in one 400.
function fill(form: PDFForm, data: Record<string, unknown>) {
	const errors: Record<string, string> = {};
	const writes: Array<() => void> = [];

	for (const [name, value] of Object.entries(data)) {
		const field = form.getFieldMaybe(name);
		if (!field) {
			errors[name] = 'No field with this name';
			continue;
		}
		try {
			writes.push(writer(field, value));
		} catch (e) {
			errors[name] = e instanceof Error ? e.message : String(e);
		}
	}
	if (Object.keys(errors).length) throw new HttpError(400, 'Some fields cannot be filled', errors);

	for (const write of writes) write();
	// Hybrid XFA forms make some viewers show the XFA copy and ignore the fields just written.
	if (form.hasXFA()) form.deleteXFA();
}

// Field appearances are drawn in Helvetica, which only encodes WinAnsi. pdf-lib
// draws "?" for anything else while storing the real value, so the page and
// the data disagree without an error.
const NOT_WINANSI = /[^\t\n\r\x20-\x7e\xa0-\xff€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ]/u;

function assertDrawable(text: string) {
	const bad = text.match(NOT_WINANSI);
	if (bad) throw new Error(`Character "${bad[0]}" cannot be drawn in Helvetica (WinAnsi only)`);
}

function writer(field: PDFField, value: unknown): () => void {
	if (field instanceof PDFTextField) {
		if (value === null) return () => field.setText(undefined);
		if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
			throw new Error('Text field takes a string, number or boolean');
		}
		const text = String(value);
		assertDrawable(text);
		const max = field.getMaxLength();
		if (max !== undefined && text.length > max) throw new Error(`Text exceeds maxLength ${max}`);
		return () => field.setText(text);
	}
	if (field instanceof PDFCheckBox) {
		if (value === null) return () => field.uncheck();
		if (typeof value !== 'boolean') throw new Error('Checkbox takes true or false');
		return () => (value ? field.check() : field.uncheck());
	}
	if (field instanceof PDFRadioGroup) {
		if (value === null) return () => field.clear();
		if (typeof value !== 'string') throw new Error('Radio group takes one option string');
		if (!field.getOptions().includes(value)) throw new Error(`Not an option: ${field.getOptions().join(', ')}`);
		return () => field.select(value);
	}
	if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
		if (value === null) return () => field.clear();
		const values = Array.isArray(value) ? value : [value];
		if (!values.every((v) => typeof v === 'string')) throw new Error('Choice field takes a string or an array of strings');
		if (values.length > 1 && !field.isMultiselect()) throw new Error('Field takes one option');
		values.forEach(assertDrawable);
		const editable = field instanceof PDFDropdown && field.isEditable();
		const options = field.getOptions();
		const bad = values.filter((v) => !options.includes(v));
		if (bad.length && !editable) throw new Error(`Not an option: ${bad.join(', ')}. Options: ${options.join(', ')}`);
		return () => field.select(values);
	}
	throw new Error(`Field type "${typeOf(field)}" cannot be filled`);
}
