/**
 * Feature Gating Utility
 * Controls access to premium/coming-soon features
 */

export type FeatureId = 'autopilot';

interface FeatureConfig {
  enabled: boolean;
  comingSoon: boolean;
  comingSoonMessage: string;
  signupUrl?: string;
}

const FEATURE_CONFIG: Record<FeatureId, FeatureConfig> = {
  autopilot: {
    enabled: true,
    comingSoon: false,
    comingSoonMessage: '',
    signupUrl: ''
  }
};

export class FeatureGating {
  static isEnabled(feature: FeatureId): boolean {
    return FEATURE_CONFIG[feature]?.enabled ?? false;
  }

  static isComingSoon(feature: FeatureId): boolean {
    return FEATURE_CONFIG[feature]?.comingSoon ?? false;
  }

  static getComingSoonMessage(feature: FeatureId): string {
    return FEATURE_CONFIG[feature]?.comingSoonMessage ?? 'Coming soon!';
  }

  static getSignupUrl(feature: FeatureId): string | undefined {
    return FEATURE_CONFIG[feature]?.signupUrl;
  }

  static getConfig(feature: FeatureId): FeatureConfig | undefined {
    return FEATURE_CONFIG[feature];
  }
}

// Webview-compatible exports (no VS Code dependencies)
export const isAutopilotComingSoon = (): boolean => FeatureGating.isComingSoon('autopilot');
