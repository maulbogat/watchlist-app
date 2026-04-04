import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { auth, getRecommendationConfig, setRecommendationConfig } from "../firebase.js";
import {
  RECOMMENDATION_CONFIG_DEFAULTS,
  type RecommendationConfig,
} from "../types/index.js";

const QUERY_KEY = ["recommendationConfig"] as const;

export type RecommendationConfigEditable = Omit<
  RecommendationConfig,
  "updatedAt" | "updatedBy" | "algorithmVersion"
>;

/** Returns the current recommendation config, falling back to defaults if the doc doesn't exist. */
export function useRecommendationConfig() {
  return useQuery<RecommendationConfig>({
    queryKey: QUERY_KEY,
    queryFn: async () => {
      const config = await getRecommendationConfig();
      if (!config) {
        return {
          ...RECOMMENDATION_CONFIG_DEFAULTS,
          updatedAt: null,
          updatedBy: "",
          algorithmVersion: "",
        };
      }
      return config;
    },
    staleTime: 5 * 60 * 1000,
  });
}

/** Mutation that writes to `config/recommendations`. */
export function useUpdateRecommendationConfig() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (config: RecommendationConfigEditable) => {
      const uid = auth.currentUser?.uid;
      if (!uid) throw new Error("Not signed in");
      await setRecommendationConfig(config, uid, "v4-graph-q1");
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
  });
}
