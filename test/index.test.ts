import { PDFDocument, PDFName, PDFString } from '@cantoo/pdf-lib';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';

let template: Uint8Array;

beforeAll(async () => {
	const doc = await PDFDocument.create();
	const page = doc.addPage([600, 400]);
	const form = doc.getForm();
	const name = form.createTextField('name');
	name.setMaxLength(10);
	name.addToPage(page, { x: 50, y: 300 });
	form.createCheckBox('agree').addToPage(page, { x: 50, y: 250 });
	const color = form.createRadioGroup('color');
	color.addOptionToPage('red', page, { x: 50, y: 200 });
	color.addOptionToPage('blue', page, { x: 100, y: 200 });
	const state = form.createDropdown('state');
	state.addOptions(['IL', 'IN']);
	state.addToPage(page, { x: 50, y: 150 });
	template = await doc.save();
});

afterEach(() => vi.unstubAllGlobals());

function multipart(path: string, fields: Record<string, string | Blob>) {
	const body = new FormData();
	for (const [k, v] of Object.entries(fields)) body.append(k, v);
	return new Request(`https://w.test${path}`, { method: 'POST', body });
}

// A hybrid form: three AcroForm fields plus an XFA template that labels them.
async function xfaPdf() {
	const blank = await PDFDocument.create();
	const page = blank.addPage();
	for (const [i, name] of ['root[0].sub[0].line[0]', 'root[0].sub[0].line[1]', 'root[0].sub[0].zip[0]'].entries()) {
		blank.getForm().createTextField(name).addToPage(page, { x: 50, y: 700 - i * 60 });
	}
	// A created document drops XFA on save; a loaded one keeps it with preserveXFA.
	const doc = await PDFDocument.load(await blank.save(), { preserveXFA: true });
	const form = doc.getForm();
	const xml = `<template><subform name="root"><subform name="sub">
		<field name="line"><caption><value><exData><body><p>1<span>  </span>Name &amp; title</p></body></exData></value></caption></field>
		<field name="line"><assist><toolTip>Second line</toolTip><speak>spoken</speak></assist></field>
		<subform><field name="zip"><assist><speak>ZIP code</speak></assist></field></subform>
	</subform></subform></template>`;
	const stream = doc.context.register(doc.context.stream(xml));
	form.acroForm.dict.set(PDFName.of('XFA'), doc.context.obj([PDFString.of('template'), stream]));

	return new File([await doc.save()], 'x.pdf');
}

const pdfFile = () => new File([template], 'form.pdf', { type: 'application/pdf' });

describe('/fields', () => {
	it('lists every field with its type and options', async () => {
		const res = await worker.fetch(multipart('/fields', { file: pdfFile() }));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { fields: Array<Record<string, unknown>> };
		expect(body.fields.map((f) => [f.name, f.type])).toEqual([
			['name', 'text'],
			['agree', 'checkbox'],
			['color', 'radio'],
			['state', 'dropdown'],
		]);
		expect(body.fields[0].maxLength).toBe(10);
		expect(body.fields[2].options).toEqual(['red', 'blue']);
	});

	it('labels a field from its /TU tooltip and gives its page', async () => {
		const doc = await PDFDocument.load(template);
		doc.getForm().getTextField('name').acroField.dict.set(PDFName.of('TU'), PDFString.of('Full  legal name'));
		const res = await worker.fetch(multipart('/fields', { file: new File([await doc.save()], 'f.pdf') }));
		const { fields } = (await res.json()) as { fields: Array<Record<string, unknown>> };
		expect(fields[0]).toMatchObject({ name: 'name', label: 'Full legal name', page: 1 });
		expect(fields[1].label).toBeNull();
	});

	it('labels hybrid-form fields from the XFA template by SOM path', async () => {
		const res = await worker.fetch(multipart('/fields', { file: await xfaPdf() }));
		const body = (await res.json()) as { xfa: boolean; fields: Array<{ name: string; label: string; description: string | null }> };
		expect(body.xfa).toBe(true);
		expect(Object.fromEntries(body.fields.map((f) => [f.name, [f.label, f.description]]))).toEqual({
			'root[0].sub[0].line[0]': ['1 Name & title', null],
			'root[0].sub[0].line[1]': ['Second line', 'spoken'],
			'root[0].sub[0].zip[0]': ['ZIP code', null],
		});
	});

	it('downloads the PDF from a url in a JSON body', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response(template)));
		const res = await worker.fetch(
			new Request('https://w.test/fields', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ url: 'https://example.com/form.pdf' }),
			}),
		);
		expect(res.status).toBe(200);
	});

	it('rejects a request with no PDF', async () => {
		const res = await worker.fetch(multipart('/fields', { data: '{}' }));
		expect(res.status).toBe(400);
	});

	it('rejects bytes that are not a PDF', async () => {
		const res = await worker.fetch(multipart('/fields', { file: new File(['hello'], 'x.pdf') }));
		expect(res.status).toBe(400);
	});

	it('rejects an encrypted PDF', async () => {
		const doc = await PDFDocument.load(template);
		doc.encrypt({ userPassword: 'secret', ownerPassword: 'owner' });
		const file = new File([await doc.save()], 'locked.pdf');
		const res = await worker.fetch(multipart('/fields', { file }));
		expect(res.status).toBe(400);
	});

	it('returns 502 when the url does not return the PDF', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response('gone', { status: 404 })));
		const res = await worker.fetch(multipart('/fields', { url: 'https://example.com/missing.pdf' }));
		expect(res.status).toBe(502);
	});

	it('returns 413 when the url declares more than 20 MB', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { headers: { 'content-length': String(21 * 1024 * 1024) } })));
		const res = await worker.fetch(multipart('/fields', { url: 'https://example.com/big.pdf' }));
		expect(res.status).toBe(413);
	});

	it('returns 415 for a raw PDF body', async () => {
		const res = await worker.fetch(new Request('https://w.test/fields', { method: 'POST', headers: { 'content-type': 'application/pdf' }, body: template }));
		expect(res.status).toBe(415);
	});

	it('rejects a non-http url', async () => {
		const res = await worker.fetch(multipart('/fields', { url: 'file:///etc/passwd' }));
		expect(res.status).toBe(400);
	});
});

describe('/fill', () => {
	it('returns a PDF with the values written', async () => {
		const data = { name: 'Café—Co', agree: true, color: 'blue', state: 'IL' };
		const res = await worker.fetch(multipart('/fill', { file: pdfFile(), data: JSON.stringify(data) }));
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('application/pdf');

		const form = (await PDFDocument.load(await res.arrayBuffer())).getForm();
		expect(form.getTextField('name').getText()).toBe('Café—Co');
		expect(form.getCheckBox('agree').isChecked()).toBe(true);
		expect(form.getRadioGroup('color').getSelected()).toBe('blue');
		expect(form.getDropdown('state').getSelected()).toEqual(['IL']);
	});

	it('accepts the jq template built from /fields, nulls included', async () => {
		const listed = await worker.fetch(multipart('/fields', { file: pdfFile() }));
		const { fields } = (await listed.json()) as { fields: Array<{ name: string; value: unknown }> };
		const data = Object.fromEntries(fields.map((f) => [f.name, f.value]));
		expect(data.color).toBeNull();
		const res = await worker.fetch(multipart('/fill', { file: pdfFile(), data: JSON.stringify(data) }));
		expect(res.status).toBe(200);
	});

	it('reports every bad entry and writes nothing', async () => {
		const data = { nope: 'x', agree: 'yes', color: 'green', name: 'far too long a name' };
		const res = await worker.fetch(multipart('/fill', { file: pdfFile(), data: JSON.stringify(data) }));
		expect(res.status).toBe(400);
		const body = (await res.json()) as { details: Record<string, string> };
		expect(Object.keys(body.details).sort()).toEqual(['agree', 'color', 'name', 'nope']);
	});

	it('rejects text that Helvetica cannot encode', async () => {
		const res = await worker.fetch(multipart('/fill', { file: pdfFile(), data: JSON.stringify({ name: 'कौस्तुभ' }) }));
		expect(res.status).toBe(400);
	});

	it('removes the XFA part so viewers show the filled fields', async () => {
		const res = await worker.fetch(multipart('/fill', { file: await xfaPdf(), data: JSON.stringify({ 'root[0].sub[0].zip[0]': '61820' }) }));
		expect(res.status).toBe(200);
		const form = (await PDFDocument.load(await res.arrayBuffer(), { preserveXFA: true })).getForm();
		expect(form.hasXFA()).toBe(false);
		expect(form.getTextField('root[0].sub[0].zip[0]').getText()).toBe('61820');
	});

	it('rejects a dropdown value outside its options, and two values for a single-select', async () => {
		const res = await worker.fetch(multipart('/fill', { file: pdfFile(), data: JSON.stringify({ state: 'OH' }) }));
		expect(((await res.json()) as { details: Record<string, string> }).details.state).toMatch(/Not an option/);
		const two = await worker.fetch(multipart('/fill', { file: pdfFile(), data: JSON.stringify({ state: ['IL', 'IN'] }) }));
		expect(((await two.json()) as { details: Record<string, string> }).details.state).toBe('Field takes one option');
	});

	it('rejects a missing data payload', async () => {
		const res = await worker.fetch(multipart('/fill', { file: pdfFile() }));
		expect(res.status).toBe(400);
	});
});

it('returns 404 for other paths and 405 for GET', async () => {
	expect((await worker.fetch(new Request('https://w.test/'))).status).toBe(404);
	expect((await worker.fetch(new Request('https://w.test/fill'))).status).toBe(405);
});
