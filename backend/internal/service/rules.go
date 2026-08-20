package service

import "github.com/P-PrPas/ChronoFish/backend/internal/domain"

// PromotionDecision is the application seam used by HTTP handlers. It keeps
// workflow policy independent from transport and persistence details.
func PromotionDecision(hasExit, latestAlive bool, ageDays, threshold int) bool {
	return domain.PromotionEligible(hasExit, latestAlive, ageDays, threshold)
}
