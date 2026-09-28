import { PDFDocument } from '@cantoo/pdf-lib';
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

	it('rejects a missing data payload', async () => {
		const res = await worker.fetch(multipart('/fill', { file: pdfFile() }));
		expect(res.status).toBe(400);
	});
});

it('returns 404 for other paths and 405 for GET', async () => {
	expect((await worker.fetch(new Request('https://w.test/'))).status).toBe(404);
	expect((await worker.fetch(new Request('https://w.test/fill'))).status).toBe(405);
});
