import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { ExternalSyncError } from "../externalSyncStatus";
import type { CalDavHttpRequest } from "./httpPort";
import { createNodeHttpAdapter } from "./nodeHttpAdapter";

/** Слушать на 127.0.0.1 с авто-портом (0), вернуть базовый origin. */
function listen(server: Server): Promise<string> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address() as AddressInfo;
			resolve(`http://127.0.0.1:${address.port}`);
		});
	});
}

function close(server: Server): Promise<void> {
	return new Promise((resolve) => server.close(() => resolve()));
}

function req(overrides: Partial<CalDavHttpRequest> & { url: string }): CalDavHttpRequest {
	return {
		method: "PROPFIND",
		headers: {},
		deadlineMs: 5000,
		...overrides,
	};
}

describe("createNodeHttpAdapter", () => {
	it("проксирует метод/заголовки/тело на сервер и возвращает статус/заголовки/текст ответа", async () => {
		// Захват в поле объекта, а не напрямую в `let`: иначе TS сужает тип чтения
		// вне колбэка до `never`, не видя мутацию сквозь вложенные замыкания.
		const received: {
			value: { method?: string; authorization?: string; depth?: string; body: string } | null;
		} = { value: null };
		const server = createServer((request, response) => {
			let raw = "";
			request.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
			request.on("end", () => {
				received.value = {
					method: request.method,
					authorization: request.headers.authorization,
					depth: request.headers.depth as string | undefined,
					body: raw,
				};
				response.setHeader("X-Multi", ["first", "second"]);
				response.writeHead(207, { "Content-Type": "application/xml; charset=utf-8" });
				response.end("<multistatus/>");
			});
		});
		const baseUrl = await listen(server);
		try {
			const adapter = createNodeHttpAdapter();
			const result = await adapter(
				req({
					url: `${baseUrl}/calendars/`,
					method: "PROPFIND",
					headers: { Authorization: "Basic dXNlcjpwYXNz", Depth: "1" },
					body: "<propfind/>",
				}),
			);

			expect(result.status).toBe(207);
			expect(result.text).toBe("<multistatus/>");
			expect(result.headers["content-type"]).toBe("application/xml; charset=utf-8");
			// Совпадающие имена заголовков склеены через ", " (§6.3 п.6).
			expect(result.headers["x-multi"]).toBe("first, second");

			expect(received.value?.method).toBe("PROPFIND");
			expect(received.value?.authorization).toBe("Basic dXNlcjpwYXNz");
			expect(received.value?.depth).toBe("1");
			expect(received.value?.body).toBe("<propfind/>");
		} finally {
			await close(server);
		}
	});

	it("следует same-origin редиректу и сохраняет Authorization на втором хопе", async () => {
		let secondHopAuth: string | undefined;
		const server = createServer((request, response) => {
			if (request.url === "/first") {
				response.writeHead(302, { Location: "/second" });
				response.end();
				return;
			}
			secondHopAuth = request.headers.authorization;
			response.writeHead(207, { "Content-Type": "application/xml" });
			response.end("<multistatus/>");
		});
		const baseUrl = await listen(server);
		try {
			const adapter = createNodeHttpAdapter();
			const result = await adapter(
				req({ url: `${baseUrl}/first`, headers: { Authorization: "Basic xyz" } }),
			);
			expect(result.status).toBe(207);
			expect(secondHopAuth).toBe("Basic xyz");
		} finally {
			await close(server);
		}
	});

	it("§14.1 release-gate: Authorization не может последовать за кросс-origin редиректом", async () => {
		// Это релиз-гейт §14.1 CalDAV-заказа для production-адаптера: редирект на
		// чужой origin обязан отклоняться БЕЗ единого сетевого обращения к цели,
		// иначе Authorization утечёт на сторонний сервер.
		let secondServerHits = 0;
		const secondServer = createServer((_request, response) => {
			secondServerHits++;
			response.writeHead(207, {});
			response.end("<multistatus/>");
		});
		const secondBaseUrl = await listen(secondServer);
		const firstServer = createServer((_request, response) => {
			response.writeHead(302, { Location: `${secondBaseUrl}/target` });
			response.end();
		});
		const firstBaseUrl = await listen(firstServer);
		try {
			const adapter = createNodeHttpAdapter();
			let caught: unknown;
			try {
				await adapter(
					req({
						url: `${firstBaseUrl}/first`,
						headers: { Authorization: "Basic secret" },
					}),
				);
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(ExternalSyncError);
			expect((caught as ExternalSyncError).code).toBe("network_error");
			expect(secondServerHits).toBe(0);
		} finally {
			await close(firstServer);
			await close(secondServer);
		}
	});

	it("обрывает цепочку same-origin редиректов после 3 хопов", async () => {
		let requests = 0;
		const server = createServer((request, response) => {
			requests++;
			const next = request.url === "/a" ? "/b" : "/a";
			response.writeHead(302, { Location: next });
			response.end();
		});
		const baseUrl = await listen(server);
		try {
			const adapter = createNodeHttpAdapter();
			let caught: unknown;
			try {
				await adapter(req({ url: `${baseUrl}/a` }));
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(ExternalSyncError);
			expect((caught as ExternalSyncError).code).toBe("network_error");
			expect((caught as ExternalSyncError).message).toBe("too many redirects");
			// Изначальный запрос + ровно 3 пройденных хопа перед отказом от 4-го.
			expect(requests).toBe(4);
		} finally {
			await close(server);
		}
	});

	it("303 после REPORT переключает метод на GET и не пересылает тело", async () => {
		const secondHop: { value: { method?: string; bodyLength: number } | null } = {
			value: null,
		};
		const server = createServer((request, response) => {
			if (request.url === "/report") {
				response.writeHead(303, { Location: "/redirected" });
				response.end();
				return;
			}
			let raw = "";
			request.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
			request.on("end", () => {
				secondHop.value = { method: request.method, bodyLength: raw.length };
				response.writeHead(200, { "Content-Type": "text/plain" });
				response.end("ok");
			});
		});
		const baseUrl = await listen(server);
		try {
			const adapter = createNodeHttpAdapter();
			const result = await adapter(
				req({ url: `${baseUrl}/report`, method: "REPORT", body: "<calendar-query/>" }),
			);
			expect(result.status).toBe(200);
			expect(secondHop.value?.method).toBe("GET");
			expect(secondHop.value?.bodyLength).toBe(0);
		} finally {
			await close(server);
		}
	});

	it("обрывает запрос по deadlineMs, если сервер не отвечает", async () => {
		const server = createServer(() => {
			// Соединение принято, ответ никогда не пишется.
		});
		const baseUrl = await listen(server);
		try {
			const adapter = createNodeHttpAdapter();
			const started = Date.now();
			let caught: unknown;
			try {
				await adapter(req({ url: `${baseUrl}/slow`, deadlineMs: 80 }));
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(ExternalSyncError);
			expect((caught as ExternalSyncError).code).toBe("timeout");
			expect((caught as ExternalSyncError).message).toBe("caldav request timed out");
			expect(Date.now() - started).toBeLessThan(500);
		} finally {
			await close(server);
		}
	});

	it("обрывает запрос по AbortSignal, сработавшему на середине", async () => {
		const server = createServer(() => {
			// Соединение принято, ответ никогда не пишется — ждём abort.
		});
		const baseUrl = await listen(server);
		try {
			const adapter = createNodeHttpAdapter();
			const controller = new AbortController();
			const pending = adapter(
				req({ url: `${baseUrl}/slow`, deadlineMs: 5000, signal: controller.signal }),
			);
			setTimeout(() => controller.abort(), 50);
			let caught: unknown;
			try {
				await pending;
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(ExternalSyncError);
			expect((caught as ExternalSyncError).code).toBe("timeout");
			expect((caught as ExternalSyncError).message).toBe("caldav request aborted");
		} finally {
			await close(server);
		}
	});

	it("уже отменённый AbortSignal отклоняет запрос без обращения к серверу", async () => {
		let hits = 0;
		const server = createServer((_request, response) => {
			hits++;
			response.writeHead(207, {});
			response.end("<multistatus/>");
		});
		const baseUrl = await listen(server);
		try {
			const adapter = createNodeHttpAdapter();
			const controller = new AbortController();
			controller.abort();
			let caught: unknown;
			try {
				await adapter(req({ url: `${baseUrl}/x`, signal: controller.signal }));
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(ExternalSyncError);
			expect((caught as ExternalSyncError).code).toBe("timeout");
			expect(hits).toBe(0);
		} finally {
			await close(server);
		}
	});

	it("обрывает ответ, превышающий байтовый предел", async () => {
		const server = createServer((_request, response) => {
			response.writeHead(200, { "Content-Type": "text/plain" });
			response.write("x".repeat(80));
			setTimeout(() => {
				response.write("x".repeat(80));
				response.end();
			}, 10);
		});
		const baseUrl = await listen(server);
		try {
			const adapter = createNodeHttpAdapter({ maxResponseBytes: 100 });
			let caught: unknown;
			try {
				await adapter(req({ url: `${baseUrl}/big` }));
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(ExternalSyncError);
			expect((caught as ExternalSyncError).code).toBe("response_too_large");
			expect((caught as ExternalSyncError).message).toBe("response exceeds byte cap");
		} finally {
			await close(server);
		}
	});

	it("возвращает 401 с WWW-Authenticate как обычный ответ, а не бросает ошибку", async () => {
		const server = createServer((_request, response) => {
			response.writeHead(401, {
				"WWW-Authenticate": 'Basic realm="caldav"',
				"Content-Type": "text/plain",
			});
			response.end("unauthorized");
		});
		const baseUrl = await listen(server);
		try {
			const adapter = createNodeHttpAdapter();
			const result = await adapter(req({ url: `${baseUrl}/protected` }));
			expect(result.status).toBe(401);
			expect(result.headers["www-authenticate"]).toBe('Basic realm="caldav"');
			expect(result.text).toBe("unauthorized");
		} finally {
			await close(server);
		}
	});

	it("сообщение об ошибке соединения не содержит URL/host/port", async () => {
		// Слушаем, чтобы узнать свободный порт, затем сразу закрываем сервер —
		// порт гарантированно отвечает ECONNREFUSED, но известен тесту.
		const probe = createServer(() => {});
		const baseUrl = await listen(probe);
		await close(probe);

		const adapter = createNodeHttpAdapter();
		let caught: unknown;
		try {
			await adapter(req({ url: `${baseUrl}/x`, deadlineMs: 2000 }));
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(ExternalSyncError);
		const err = caught as ExternalSyncError;
		expect(err.code).toBe("network_error");
		const url = new URL(baseUrl);
		expect(err.message).not.toContain(url.hostname);
		expect(err.message).not.toContain(url.port);
		expect(err.message).not.toContain(baseUrl);
	});
});
