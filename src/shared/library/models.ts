export async function modelRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response
  try { response = await fetch(`/api/models${path}`, { ...options, signal: AbortSignal.any([AbortSignal.timeout(60_000), ...(options.signal ? [options.signal] : [])]) }) }
  catch (error) {
    if (options.signal?.aborted) throw error
    throw new Error('Cannot reach the model library. Check your connection and that the server is running, then retry.')
  }
  const result = await response.json().catch(() => null)
  if (!response.ok || !result) throw new Error(typeof result?.error === 'string' ? result.error : 'The model library is unavailable. Check that the server is running, then retry.')
  return result as T
}
