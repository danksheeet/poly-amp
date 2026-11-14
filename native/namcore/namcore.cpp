// C-обёртка над официальной библиотекой NeuralAmpModelerCore (Steven Atkinson, MIT).
// Через неё приложение исполняет модели .nam любых архитектур, которые понимает сама библиотека:
// WaveNet A1 и A2 (включая «двухразмерные» контейнеры), LSTM и другие.
#include <algorithm>
#include <cstring>
#include <exception>
#include <filesystem>
#include <memory>
#include <vector>

#include "NAM/activations.h"
#include "NAM/dsp.h"
#include "NAM/get_dsp.h"
#include "NAM/slimmable.h"
#include "NAM/version.h"

#define API extern "C" __declspec(dllexport)

namespace
{
struct Handle
{
  std::unique_ptr<nam::DSP> dsp;
  std::vector<float> in, out;
  int maxBlock = 0;
};

void setError(char* err, int len, const char* msg)
{
  if (err != nullptr && len > 0)
    strncpy_s(err, static_cast<size_t>(len), msg, _TRUNCATE);
}
} // namespace

/// Версия библиотеки: major * 10000 + minor * 100 + patch.
API int __cdecl namcore_version()
{
  return NEURAL_AMP_MODELER_DSP_VERSION_MAJOR * 10000 + NEURAL_AMP_MODELER_DSP_VERSION_MINOR * 100
         + NEURAL_AMP_MODELER_DSP_VERSION_PATCH;
}

/// Загрузить модель. Возвращает nullptr и текст ошибки в err, если файл не подошёл.
API void* __cdecl namcore_create(const wchar_t* path, int maxBlock, char* err, int errLen)
{
  try
  {
    // как в плагине NAM: быстрый tanh вместо точного (на слух неотличимо, считается намного быстрее)
    static const bool fastTanh = (nam::activations::Activation::enable_fast_tanh(), true);
    (void)fastTanh;

    std::unique_ptr<nam::DSP> dsp = nam::get_dsp(std::filesystem::path(path));
    if (!dsp)
    {
      setError(err, errLen, "model could not be created");
      return nullptr;
    }
    if (dsp->NumInputChannels() != 1 || dsp->NumOutputChannels() != 1)
    {
      setError(err, errLen, "only mono models are supported");
      return nullptr;
    }
    double rate = dsp->GetExpectedSampleRate();
    if (rate <= 0.0)
      rate = 48000.0;
    maxBlock = std::max(16, maxBlock);
    dsp->Reset(rate, maxBlock); // выделяет буферы и прогревает модель тишиной

    auto* h = new Handle();
    h->dsp = std::move(dsp);
    h->in.assign(static_cast<size_t>(maxBlock), 0.0f);
    h->out.assign(static_cast<size_t>(maxBlock), 0.0f);
    h->maxBlock = maxBlock;
    return h;
  }
  catch (const std::exception& e)
  {
    setError(err, errLen, e.what());
  }
  catch (...)
  {
    setError(err, errLen, "unknown error");
  }
  return nullptr;
}

API void __cdecl namcore_destroy(void* handle)
{
  delete static_cast<Handle*>(handle);
}

/// Сведения о модели. Любой указатель может быть nullptr.
API void __cdecl namcore_info(void* handle, double* sampleRate, int* hasLoudness, double* loudness, int* slimmable)
{
  auto* h = static_cast<Handle*>(handle);
  if (sampleRate != nullptr)
    *sampleRate = h->dsp->GetExpectedSampleRate();
  if (hasLoudness != nullptr)
    *hasLoudness = h->dsp->HasLoudness() ? 1 : 0;
  if (loudness != nullptr)
    *loudness = h->dsp->HasLoudness() ? h->dsp->GetLoudness() : 0.0;
  if (slimmable != nullptr)
    *slimmable = dynamic_cast<nam::SlimmableModel*>(h->dsp.get()) != nullptr ? 1 : 0;
}

/// Для моделей с несколькими размерами в одном файле: 0.0 — самый лёгкий, 1.0 — самый точный.
/// Не из аудиопотока. Возвращает 0, если модель не поддерживает выбор размера.
API int __cdecl namcore_set_size(void* handle, double value)
{
  try
  {
    auto* h = static_cast<Handle*>(handle);
    auto* slim = dynamic_cast<nam::SlimmableModel*>(h->dsp.get());
    if (slim == nullptr)
      return 0;
    slim->SetSlimmableSize(std::clamp(value, 0.0, 1.0));
    return 1;
  }
  catch (...)
  {
    return 0;
  }
}

/// Обработать блок. Вход и выход могут быть одним и тем же буфером.
API void __cdecl namcore_process(void* handle, const float* input, float* output, int frames)
{
  auto* h = static_cast<Handle*>(handle);
  try
  {
    while (frames > 0)
    {
      const int n = std::min(frames, h->maxBlock);
      std::memcpy(h->in.data(), input, static_cast<size_t>(n) * sizeof(float));
      float* ins[1] = {h->in.data()};
      float* outs[1] = {h->out.data()};
      h->dsp->process(ins, outs, n);
      std::memcpy(output, h->out.data(), static_cast<size_t>(n) * sizeof(float));
      input += n;
      output += n;
      frames -= n;
    }
  }
  catch (...)
  {
    if (frames > 0)
      std::memset(output, 0, static_cast<size_t>(frames) * sizeof(float));
  }
}
