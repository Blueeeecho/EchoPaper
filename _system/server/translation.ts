import type { FastifyInstance } from 'fastify';
import { isTranslationService } from '../shared/model-providers';
import type { ProviderOptions, ProviderRegistry } from './model-providers';
import { HttpError, registeredRoot } from './security';
import { translateWithService, validateServiceTranslation, type ServiceTranslation } from './translation-services';

type SelectionTranslation = ServiceTranslation & { projectId?: string; resourceId?: string; sourceId: string };

export function registerUnifiedTranslationRoutes(app: FastifyInstance, workspaceRoot: string, registry: ProviderRegistry, options: ProviderOptions & { validateResource?: (id: string) => Promise<unknown> } = {}) {
  const active = new Set<AbortController>();
  const upstream = options.fetch ?? fetch;
  app.addHook('preClose', async () => { for (const controller of active) controller.abort(); });

  async function translate(body: SelectionTranslation, signal: AbortSignal) {
    validateServiceTranslation(body);
    if (Object.keys(body).some(key => !['resourceId','projectId','sourceId','text','target','source','sourceLanguage','context'].includes(key))) {
      throw new HttpError(400, '翻译只接受选区、语种和翻译来源，不接受聊天历史或助手上下文。');
    }
    if (typeof body.sourceId !== 'string') throw new HttpError(400, '请选择翻译来源。');
    if (body.resourceId) {
      if (body.projectId || !options.validateResource) throw new HttpError(400, '翻译上下文无效。');
      await options.validateResource(body.resourceId);
    } else await registeredRoot(workspaceRoot, body.projectId!);
    const { data } = await registry.read();
    const source = data.translations.find(source => source.id === body.sourceId && source.enabled);
    const model = data.models.find(model => model.id === source?.modelId && model.enabled);
    const provider = data.providers.find(provider => provider.id === model?.providerId && provider.enabled);
    if (!source || !model || !provider) throw new HttpError(400, '请先启用此翻译来源、连接与模型。');
    if (!isTranslationService(provider)) throw new HttpError(400, '此旧翻译来源使用助手模型，已停止调用。请在翻译 API 设置中替换为翻译服务。');
    if (body.context && provider.kind !== 'deepl') throw new HttpError(400, '此翻译来源不支持额外上下文；请关闭上下文或选用 DeepL。');
    if (active.size >= 32) throw new HttpError(429, '翻译请求过多，请停止或等待当前请求。');

    const controller = new AbortController(), timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), 90000);
    const upstreamSignal = AbortSignal.any([signal, controller.signal, timeoutController.signal]);
    active.add(controller);
    let release: (() => void) | undefined;
    try {
      upstreamSignal.throwIfAborted();
      const key = await registry.getKey(provider);
      upstreamSignal.throwIfAborted();
      if (provider.auth === 'bearer' && !key) throw new HttpError(503, '此翻译来源尚未配置密钥。', undefined, true);
      release = await registry.scheduler.acquire(provider, 'translation', upstreamSignal);
      upstreamSignal.throwIfAborted();
      const text = await translateWithService(provider, model, key, body, upstreamSignal, upstream);
      upstreamSignal.throwIfAborted();
      return { text, model: model.model, provider: provider.label };
    } catch (error) {
      if (signal.aborted || controller.signal.aborted) throw new HttpError(499, '翻译已停止。', { code: 'translation_cancelled' }, true);
      if (timeoutController.signal.aborted) throw new HttpError(504, '翻译等待超过 90 秒，请重试。', { code: 'translation_timeout' }, true);
      const message = error instanceof HttpError && (error.expose || error.extra?.error === error.message)
        ? error.message : '翻译服务失败，请重试或检查翻译来源。';
      throw new HttpError(error instanceof HttpError ? error.statusCode : 502, message, { code: 'translation_upstream_error' }, true);
    } finally {
      clearTimeout(timer);
      controller.abort();
      release?.();
      active.delete(controller);
    }
  }

  app.post<{ Body: SelectionTranslation }>('/api/ai/translate', { bodyLimit: 128 * 1024 }, async (request, reply) => {
    const controller = new AbortController();
    const close = () => { if (!reply.raw.writableEnded) controller.abort(); };
    reply.raw.on('close', close);
    const started = Date.now();
    reply.header('X-Translation-Request-Id', request.id);
    try {
      const result = await translate(request.body, controller.signal);
      if (reply.raw.destroyed) return reply;
      return reply.header('Cache-Control','no-store').header('X-Content-Type-Options','nosniff').type('application/x-ndjson; charset=utf-8').send(
        JSON.stringify({ type: 'delta', text: result.text }) + '\n' +
        JSON.stringify({ type: 'done', model: result.model, provider: result.provider, finishReason: 'stop' }) + '\n',
      );
    } catch (error) {
      if (!(error instanceof HttpError) || typeof error.extra?.code !== 'string') {
        if (reply.raw.destroyed) return reply;
        throw error;
      }
      const diagnostic = { code: error.extra.code, requestId: request.id, sourceId: request.body.sourceId, elapsedMs: Date.now() - started };
      request.log.warn(diagnostic, 'Translation request failed');
      if (reply.raw.destroyed) return reply;
      return reply.code(error.statusCode).send({ type: 'error', error: error.message, ...diagnostic });
    } finally {
      reply.raw.off('close', close);
    }
  });

  return translate;
}
