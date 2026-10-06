package local.health;

import java.math.BigDecimal;
import java.math.RoundingMode;

/** A small Java 8 business example that can generate real test coverage. */
public final class PriceService {
    /**
     * Calculates a payable total with exact decimal arithmetic.
     * @param unitPrice nonnegative price per item
     * @param quantity nonnegative item count
     * @return amount rounded to two decimal places
     * @throws IllegalArgumentException if either input is invalid
     */
    public BigDecimal total(BigDecimal unitPrice, int quantity) {
        if (unitPrice == null || unitPrice.signum() < 0 || quantity < 0) {
            throw new IllegalArgumentException("Price and quantity must be nonnegative");
        }
        return unitPrice.multiply(BigDecimal.valueOf(quantity)).setScale(2, RoundingMode.HALF_UP);
    }
}
