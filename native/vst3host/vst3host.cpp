// Хост плагинов VST3 для Poly Amp: тонкая обёртка над официальным VST3 SDK с плоским C-интерфейсом
// для C# (P/Invoke). Загрузка, настройка, окно и состояние — в потоке интерфейса; vh_process —
// в аудиопотоке. Сбой плагина в обработке ловим (SEH): плагин выключается, приложение живёт.

#include "public.sdk/source/vst/hosting/module.h"
#include "public.sdk/source/vst/hosting/plugprovider.h"
#include "public.sdk/source/vst/hosting/hostclasses.h"
#include "public.sdk/source/vst/hosting/processdata.h"
#include "public.sdk/source/vst/hosting/parameterchanges.h"
#include "public.sdk/source/vst/hosting/eventlist.h"
#include "public.sdk/source/common/memorystream.h"
#include "public.sdk/source/vst/utility/stringconvert.h"
#include "pluginterfaces/base/funknownimpl.h"
#include "pluginterfaces/vst/ivstaudioprocessor.h"
#include "pluginterfaces/vst/ivstcomponent.h"
#include "pluginterfaces/vst/ivsteditcontroller.h"
#include "pluginterfaces/gui/iplugview.h"
#include "pluginterfaces/gui/iplugviewcontentscalesupport.h"

#include <windows.h>
#include <atomic>
#include <cstring>
#include <map>
#include <memory>
#include <string>
#include <vector>

using namespace Steinberg;
using namespace Steinberg::Vst;

#define VH_API extern "C" __declspec(dllexport)

namespace {

// ---------- приложение-хост: так плагин узнаёт, кто его загрузил ----------
class PolyHostApp : public HostApplication
{
public:
	tresult PLUGIN_API getName (String128 name) override
	{
		return VST3::StringConvert::convert ("Poly Amp", name) ? kResultTrue : kInternalError;
	}
};

PolyHostApp* host ()
{
	static PolyHostApp* app = [] {
		auto* a = new PolyHostApp ();
		PluginContextFactory::instance ().setPluginContext (a);
		return a;
	}();
	return app;
}

// Один модуль (DLL) на путь: повторная загрузка того же модуля заново вызывала бы InitDll
std::map<std::string, std::weak_ptr<VST3::Hosting::Module>> modules;

VST3::Hosting::Module::Ptr loadModule (const std::string& path, std::string& error)
{
	if (auto it = modules.find (path); it != modules.end ())
		if (auto m = it->second.lock ())
			return m;
	auto m = VST3::Hosting::Module::create (path, error);
	if (m)
		modules[path] = m;
	return m;
}

std::string utf8 (const wchar_t* s)
{
	if (!s)
		return {};
	int n = WideCharToMultiByte (CP_UTF8, 0, s, -1, nullptr, 0, nullptr, nullptr);
	std::string out (n > 0 ? n - 1 : 0, '\0');
	if (n > 1)
		WideCharToMultiByte (CP_UTF8, 0, s, -1, out.data (), n, nullptr, nullptr);
	return out;
}

void copyOut (const std::string& s, char* buf, int cap)
{
	if (!buf || cap <= 0)
		return;
	size_t n = std::min<size_t> (s.size (), static_cast<size_t> (cap - 1));
	std::memcpy (buf, s.data (), n);
	buf[n] = 0;
}

std::string jsonEscape (const std::string& s)
{
	std::string o;
	for (unsigned char c : s)
	{
		switch (c)
		{
			case '"': o += "\\\""; break;
			case '\\': o += "\\\\"; break;
			case '\n': o += "\\n"; break;
			case '\r': o += "\\r"; break;
			case '\t': o += "\\t"; break;
			default:
				if (c < 0x20)
				{
					char b[8];
					snprintf (b, sizeof b, "\\u%04x", c);
					o += b;
				}
				else
					o += static_cast<char> (c);
		}
	}
	return o;
}

struct Plugin;

// ---------- ответы плагину: правки из его окна, «состояние изменилось», размер окна ----------
class Handler : public U::ImplementsNonDestroyable<U::Directly<IComponentHandler, IComponentHandler2, IPlugFrame>>
{
public:
	explicit Handler (Plugin* p) : plugin (p) {}

	tresult PLUGIN_API beginEdit (ParamID) override { return kResultOk; }
	tresult PLUGIN_API performEdit (ParamID id, ParamValue value) override;
	tresult PLUGIN_API endEdit (ParamID) override;
	tresult PLUGIN_API restartComponent (int32 flags) override;

	tresult PLUGIN_API setDirty (TBool) override;
	tresult PLUGIN_API requestOpenEditor (FIDString) override { return kResultFalse; }
	tresult PLUGIN_API startGroupEdit () override { return kResultOk; }
	tresult PLUGIN_API finishGroupEdit () override { return kResultOk; }

	tresult PLUGIN_API resizeView (IPlugView* view, ViewRect* newSize) override;

	Plugin* plugin;
};

struct Plugin
{
	VST3::Hosting::Module::Ptr module;
	IPtr<PlugProvider> provider;
	IPtr<IComponent> component;
	IPtr<IAudioProcessor> processor;
	IPtr<IEditController> controller;
	std::unique_ptr<Handler> handler;

	HostProcessData data;
	ParameterChanges inChanges;
	ParameterChangeTransfer transfer;
	EventList events;
	ProcessContext context {};

	std::atomic<bool> processing {false};
	std::atomic<int> inProcess {0};
	std::atomic<bool> faulted {false};
	std::atomic<bool> dirty {false};
	bool active = false;
	int maxBlock = 0;
	int inChannels = 0, outChannels = 0;

	IPtr<IPlugView> view;
	HWND parent = nullptr;
	bool resizing = false;
	std::vector<char> stateCache;
};

tresult PLUGIN_API Handler::performEdit (ParamID id, ParamValue value)
{
	plugin->transfer.addChange (id, value, 0);
	plugin->dirty = true;
	return kResultOk;
}

tresult PLUGIN_API Handler::endEdit (ParamID)
{
	plugin->dirty = true;
	return kResultOk;
}

tresult PLUGIN_API Handler::restartComponent (int32)
{
	plugin->dirty = true; // плагин сам поменял параметры (например, загрузил свой пресет)
	return kResultOk;
}

tresult PLUGIN_API Handler::setDirty (TBool state)
{
	if (state)
		plugin->dirty = true;
	return kResultOk;
}

// Окно-хозяин подгоняем так, чтобы его внутренняя область была ровно w×h
void resizeHostWindow (HWND parent, int w, int h)
{
	HWND top = GetAncestor (parent, GA_ROOT);
	if (!top)
		return;
	RECT rc {0, 0, w, h};
	DWORD style = static_cast<DWORD> (GetWindowLongPtrW (top, GWL_STYLE));
	DWORD ex = static_cast<DWORD> (GetWindowLongPtrW (top, GWL_EXSTYLE));
	AdjustWindowRectExForDpi (&rc, style, FALSE, ex, GetDpiForWindow (top));
	SetWindowPos (top, nullptr, 0, 0, rc.right - rc.left, rc.bottom - rc.top,
	              SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
}

tresult PLUGIN_API Handler::resizeView (IPlugView* view, ViewRect* newSize)
{
	Plugin* p = plugin;
	if (!newSize || !view || view != p->view.get () || !p->parent)
		return kInvalidArgument;
	if (p->resizing)
		return kResultFalse;
	p->resizing = true;
	resizeHostWindow (p->parent, newSize->getWidth (), newSize->getHeight ());
	p->resizing = false;
	ViewRect r;
	if (view->getSize (&r) != kResultTrue || r.getWidth () != newSize->getWidth () || r.getHeight () != newSize->getHeight ())
		view->onSize (newSize);
	return kResultTrue;
}

int busChannels (IComponent* c, BusDirection dir)
{
	if (c->getBusCount (kAudio, dir) <= 0)
		return 0;
	BusInfo info {};
	return c->getBusInfo (kAudio, dir, 0, info) == kResultOk ? info.channelCount : 0;
}

// Главные шины — стерео (гитара идёт на оба входа), остальные (сайдчейн) выключены
void setupBuses (Plugin& p)
{
	IComponent* c = p.component.get ();
	int32 nIn = c->getBusCount (kAudio, kInput), nOut = c->getBusCount (kAudio, kOutput);
	std::vector<SpeakerArrangement> ins (nIn), outs (nOut);
	for (int32 i = 0; i < nIn; i++)
		p.processor->getBusArrangement (kInput, i, ins[i]);
	for (int32 i = 0; i < nOut; i++)
		p.processor->getBusArrangement (kOutput, i, outs[i]);
	if (nIn > 0)
		ins[0] = SpeakerArr::kStereo;
	if (nOut > 0)
		outs[0] = SpeakerArr::kStereo;
	if (p.processor->setBusArrangements (ins.data (), nIn, outs.data (), nOut) != kResultTrue && nIn > 0)
	{
		ins[0] = SpeakerArr::kMono; // моно-вход, стерео-выход
		p.processor->setBusArrangements (ins.data (), nIn, outs.data (), nOut);
	}
	for (int32 i = 0; i < nIn; i++)
		c->activateBus (kAudio, kInput, i, i == 0);
	for (int32 i = 0; i < nOut; i++)
		c->activateBus (kAudio, kOutput, i, i == 0);
	for (int32 i = 0; i < c->getBusCount (kEvent, kInput); i++)
		c->activateBus (kEvent, kInput, i, false);
	for (int32 i = 0; i < c->getBusCount (kEvent, kOutput); i++)
		c->activateBus (kEvent, kOutput, i, false);
	p.inChannels = busChannels (c, kInput);
	p.outChannels = busChannels (c, kOutput);
}

void stop (Plugin& p)
{
	p.processing = false;
	for (int i = 0; i < 2000 && p.inProcess.load () > 0; i++)
		Sleep (1); // аудиопоток дорабатывает текущий блок
	if (p.active)
	{
		p.processor->setProcessing (false);
		p.component->setActive (false);
		p.active = false;
	}
}

// Отдельная функция без объектов C++: внутри неё можно ловить SEH-исключения плагина
int sehProcess (IAudioProcessor* proc, ProcessData* d)
{
	__try
	{
		return proc->process (*d) == kResultOk ? 0 : 1;
	}
	__except (EXCEPTION_EXECUTE_HANDLER)
	{
		return -1;
	}
}

void closeEditor (Plugin& p)
{
	if (!p.view)
		return;
	p.view->setFrame (nullptr);
	p.view->removed ();
	p.view = nullptr;
	p.parent = nullptr;
}

} // namespace

// ================= C-интерфейс =================

/**
 * Классы эффектов в модуле .vst3 (загружает модуль; вызывать в отдельном процессе-сканере).
 * Пишет JSON {"classes":[{cid,name,vendor,version,category,sub}], "error":...}; возвращает длину JSON.
 */
VH_API int vh_scan (const wchar_t* path, char* out, int cap)
{
	host ();
	std::string error;
	auto module = loadModule (utf8 (path), error);
	std::string json = "{\"classes\":[";
	if (module)
	{
		bool first = true;
		for (const auto& ci : module->getFactory ().classInfos ())
		{
			if (ci.category () != kVstAudioEffectClass)
				continue;
			if (!first)
				json += ",";
			first = false;
			json += "{\"cid\":\"" + ci.ID ().toString () + "\",\"name\":\"" + jsonEscape (ci.name ()) +
			        "\",\"vendor\":\"" + jsonEscape (ci.vendor ()) + "\",\"version\":\"" +
			        jsonEscape (ci.version ()) + "\",\"sub\":\"" + jsonEscape (ci.subCategoriesString ()) + "\"}";
		}
	}
	json += "],\"error\":";
	json += module ? "null" : "\"" + jsonEscape (error.empty () ? "Couldn't load the plugin" : error) + "\"";
	json += "}";
	copyOut (json, out, cap);
	return static_cast<int> (json.size ());
}

/** Загрузить плагин (класс cid из модуля path). Поток интерфейса. null — ошибка, текст в err. */
VH_API void* vh_load (const wchar_t* path, const char* cid, char* err, int errCap)
{
	host ();
	auto p = std::make_unique<Plugin> ();
	std::string error;
	p->module = loadModule (utf8 (path), error);
	if (!p->module)
	{
		copyOut (error.empty () ? "Couldn't load the plugin file." : error, err, errCap);
		return nullptr;
	}
	// moduleinfo.json, собранный на другой системе, может записать CID в другом порядке байт — пробуем оба
	std::string cidText (cid ? cid : "");
	auto uidCom = VST3::UID::fromString (cidText, true);
	auto uidPlain = VST3::UID::fromString (cidText, false);
	const VST3::Hosting::ClassInfo* found = nullptr;
	auto infos = p->module->getFactory ().classInfos ();
	for (const auto& ci : infos)
		if (ci.category () == kVstAudioEffectClass && ((uidCom && ci.ID () == *uidCom) || (uidPlain && ci.ID () == *uidPlain)))
			found = &ci;
	if (!found)
	{
		copyOut ("This plugin is no longer in its file — it may have been updated or removed.", err, errCap);
		return nullptr;
	}
	p->provider = owned (new PlugProvider (p->module->getFactory (), *found, true));
	if (!p->provider->initialize ())
	{
		copyOut ("The plugin failed to start.", err, errCap);
		return nullptr;
	}
	p->component = p->provider->getComponentPtr ();
	p->controller = p->provider->getControllerPtr ();
	p->processor = U::cast<IAudioProcessor> (p->component);
	if (!p->component || !p->processor)
	{
		copyOut ("This isn't an audio effect plugin.", err, errCap);
		return nullptr;
	}
	if (p->processor->canProcessSampleSize (kSample32) != kResultTrue)
	{
		copyOut ("The plugin doesn't support 32-bit float processing.", err, errCap);
		return nullptr;
	}
	p->handler = std::make_unique<Handler> (p.get ());
	if (p->controller)
		p->controller->setComponentHandler (p->handler.get ());
	setupBuses (*p);
	if (p->outChannels <= 0)
	{
		copyOut ("The plugin has no audio output.", err, errCap);
		return nullptr;
	}
	p->transfer.setMaxParameters (4096);
	p->inChanges.setMaxParameters (4096);
	return p.release ();
}

/** Частота и наибольший блок; перезапускает обработку. Поток интерфейса, аудио — не в этом плагине. */
VH_API int vh_setup (void* h, double sampleRate, int maxBlock)
{
	auto* p = static_cast<Plugin*> (h);
	if (!p || maxBlock <= 0)
		return -1;
	stop (*p);
	ProcessSetup setup {kRealtime, kSample32, maxBlock, sampleRate};
	if (p->processor->setupProcessing (setup) != kResultOk)
		return -2;
	p->data.unprepare ();
	p->data.prepare (*p->component, maxBlock, kSample32);
	p->data.inputParameterChanges = &p->inChanges;
	p->data.inputEvents = &p->events;
	p->data.processContext = &p->context;
	p->context = {};
	p->context.sampleRate = sampleRate;
	p->context.tempo = 120;
	p->context.timeSigNumerator = 4;
	p->context.timeSigDenominator = 4;
	p->context.state = ProcessContext::kTempoValid | ProcessContext::kTimeSigValid;
	p->maxBlock = maxBlock;
	if (p->component->setActive (true) != kResultOk)
		return -3;
	p->active = true;
	p->processor->setProcessing (true); // многие плагины отвечают kNotImplemented — это не ошибка
	p->faulted = false;
	p->processing = true;
	return 0;
}

/**
 * Аудиопоток: обработать стерео на месте. 1 — обработано, 0 — пропущено (сигнал как был),
 * -1 — плагин упал (дальше пропускается).
 */
VH_API int vh_process (void* h, float* l, float* r, int n)
{
	auto* p = static_cast<Plugin*> (h);
	if (!p || n <= 0)
		return 0;
	p->inProcess++;
	int result = 0;
	if (p->processing && !p->faulted && n <= p->maxBlock)
	{
		ProcessData& d = p->data;
		if (d.numInputs > 0 && d.inputs[0].numChannels > 0)
		{
			float** in = d.inputs[0].channelBuffers32;
			if (d.inputs[0].numChannels > 1)
			{
				std::memcpy (in[0], l, sizeof (float) * n);
				std::memcpy (in[1], r, sizeof (float) * n);
			}
			else // моно-вход после стерео-эффекта: сводим, как и цепочка сводит перед моно-блоком
				for (int i = 0; i < n; i++)
					in[0][i] = (l[i] + r[i]) * 0.5f;
		}
		d.numSamples = n;
		p->transfer.transferChangesTo (p->inChanges);
		int rc = sehProcess (p->processor.get (), &d);
		if (rc < 0)
		{
			p->faulted = true;
			result = -1;
		}
		else if (d.numOutputs > 0 && d.outputs[0].numChannels > 0)
		{
			float** out = d.outputs[0].channelBuffers32;
			std::memcpy (l, out[0], sizeof (float) * n);
			std::memcpy (r, out[d.outputs[0].numChannels > 1 ? 1 : 0], sizeof (float) * n);
			result = 1;
		}
		p->inChanges.clearQueue ();
		p->events.clear ();
		p->context.projectTimeSamples += n;
		p->context.continousTimeSamples += n;
	}
	p->inProcess--;
	return result;
}

/** Изменилось ли состояние плагина с прошлого вызова (правки в его окне, свой пресет). */
VH_API int vh_take_dirty (void* h)
{
	auto* p = static_cast<Plugin*> (h);
	return p && p->dirty.exchange (false) ? 1 : 0;
}

/** Состояние плагина целиком. Возвращает размер; копирует, если места в buf хватает. Поток интерфейса. */
VH_API int vh_get_state (void* h, unsigned char* buf, int cap)
{
	auto* p = static_cast<Plugin*> (h);
	if (!p)
		return -1;
	if (!buf || cap <= 0 || p->stateCache.empty ())
	{
		MemoryStream cs, ks;
		if (p->component->getState (&cs) != kResultOk)
			cs.setSize (0);
		if (!p->controller || p->controller->getState (&ks) != kResultOk)
			ks.setSize (0);
		auto put32 = [&] (uint32_t v) {
			for (int i = 0; i < 4; i++)
				p->stateCache.push_back (static_cast<char> ((v >> (8 * i)) & 0xff));
		};
		p->stateCache.clear ();
		p->stateCache.insert (p->stateCache.end (), {'P', 'A', 'V', '3'});
		put32 (static_cast<uint32_t> (cs.getSize ()));
		p->stateCache.insert (p->stateCache.end (), cs.getData (), cs.getData () + cs.getSize ());
		put32 (static_cast<uint32_t> (ks.getSize ()));
		p->stateCache.insert (p->stateCache.end (), ks.getData (), ks.getData () + ks.getSize ());
	}
	int size = static_cast<int> (p->stateCache.size ());
	if (buf && cap >= size)
	{
		std::memcpy (buf, p->stateCache.data (), size);
		p->stateCache.clear ();
	}
	return size;
}

/** Вернуть сохранённое состояние. Поток интерфейса. */
VH_API int vh_set_state (void* h, const unsigned char* buf, int len)
{
	auto* p = static_cast<Plugin*> (h);
	if (!p || !buf || len < 12 || std::memcmp (buf, "PAV3", 4) != 0)
		return -1;
	auto get32 = [&] (int at) {
		return static_cast<uint32_t> (buf[at]) | (static_cast<uint32_t> (buf[at + 1]) << 8) |
		       (static_cast<uint32_t> (buf[at + 2]) << 16) | (static_cast<uint32_t> (buf[at + 3]) << 24);
	};
	uint32_t cn = get32 (4);
	if (8ull + cn + 4 > static_cast<uint64_t> (len))
		return -1;
	uint32_t kn = get32 (8 + cn);
	if (12ull + cn + kn > static_cast<uint64_t> (len))
		return -1;
	if (cn > 0)
	{
		MemoryStream cs (const_cast<unsigned char*> (buf + 8), cn);
		p->component->setState (&cs);
		if (p->controller)
		{
			MemoryStream cs2 (const_cast<unsigned char*> (buf + 8), cn);
			p->controller->setComponentState (&cs2);
		}
	}
	if (kn > 0 && p->controller)
	{
		MemoryStream ks (const_cast<unsigned char*> (buf + 12 + cn), kn);
		p->controller->setState (&ks);
	}
	p->dirty = false;
	return 0;
}

/**
 * Открыть окно плагина внутри окна parent (HWND). Окно-хозяин подгоняется под размер плагина.
 * 0 — открыто; size: ширина и высота, canResize — можно ли тянуть окно.
 */
VH_API int vh_open_editor (void* h, void* parentHwnd, int* width, int* height, int* canResize)
{
	auto* p = static_cast<Plugin*> (h);
	if (!p || !parentHwnd)
		return -1;
	if (!p->controller)
		return -2;
	closeEditor (*p);
	IPtr<IPlugView> view = owned (p->controller->createView (ViewType::kEditor));
	if (!view)
		return -3;
	if (view->isPlatformTypeSupported (kPlatformTypeHWND) != kResultTrue)
		return -4;
	p->view = view;
	p->parent = static_cast<HWND> (parentHwnd);
	view->setFrame (p->handler.get ());
	if (auto css = U::cast<IPlugViewContentScaleSupport> (view))
		css->setContentScaleFactor (GetDpiForWindow (p->parent) / 96.0f);
	ViewRect r;
	if (view->getSize (&r) == kResultTrue && r.getWidth () > 0 && r.getHeight () > 0)
		resizeHostWindow (p->parent, r.getWidth (), r.getHeight ());
	if (view->attached (p->parent, kPlatformTypeHWND) != kResultTrue)
	{
		view->setFrame (nullptr);
		p->view = nullptr;
		p->parent = nullptr;
		return -5;
	}
	if (view->getSize (&r) == kResultTrue && r.getWidth () > 0 && r.getHeight () > 0)
		resizeHostWindow (p->parent, r.getWidth (), r.getHeight ());
	if (width)
		*width = r.getWidth ();
	if (height)
		*height = r.getHeight ();
	if (canResize)
		*canResize = view->canResize () == kResultTrue ? 1 : 0;
	return 0;
}

/** Пользователь потянул окно: предложить плагину размер; в width/height — что плагин согласился принять. */
VH_API int vh_editor_resized (void* h, int* width, int* height)
{
	auto* p = static_cast<Plugin*> (h);
	if (!p || !p->view || p->resizing || !width || !height)
		return -1;
	ViewRect r (0, 0, *width, *height);
	p->view->checkSizeConstraint (&r);
	p->view->onSize (&r);
	*width = r.getWidth ();
	*height = r.getHeight ();
	return 0;
}

VH_API void vh_close_editor (void* h)
{
	if (auto* p = static_cast<Plugin*> (h))
		closeEditor (*p);
}

/** Выгрузить плагин. Поток интерфейса; аудиопоток к этому времени уже не должен его вызывать. */
VH_API void vh_unload (void* h)
{
	auto* p = static_cast<Plugin*> (h);
	if (!p)
		return;
	closeEditor (*p);
	stop (*p);
	if (p->controller)
		p->controller->setComponentHandler (nullptr);
	p->data.unprepare ();
	p->processor = nullptr;
	p->controller = nullptr;
	p->component = nullptr;
	p->provider = nullptr;
	p->module = nullptr;
	delete p;
}

/** Задержка плагина в сэмплах (для сведений). */
VH_API int vh_latency (void* h)
{
	auto* p = static_cast<Plugin*> (h);
	return p && p->processor ? static_cast<int> (p->processor->getLatencySamples ()) : 0;
}
