// expo-local-authentication 适配：桌面首版无生物识别（design.md「首版能力降级」）。
export const hasHardwareAsync = async () => false;
export const isEnrolledAsync = async () => false;
export const supportedAuthenticationTypesAsync = async () => [];
export const authenticateAsync = async () => ({ success: false, error: 'not_available' });

export default {
  hasHardwareAsync,
  isEnrolledAsync,
  supportedAuthenticationTypesAsync,
  authenticateAsync,
};
