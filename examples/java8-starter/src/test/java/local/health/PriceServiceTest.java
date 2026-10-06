package local.health;

import java.math.BigDecimal;
import org.junit.Test;
import static org.junit.Assert.assertEquals;

/** Tests valid amounts and each rejected input boundary. */
public class PriceServiceTest {
    @Test public void calculatesExactTotal() {
        assertEquals(new BigDecimal("37.05"), new PriceService().total(new BigDecimal("12.35"), 3));
    }
    @Test public void acceptsZeroQuantity() {
        assertEquals(new BigDecimal("0.00"), new PriceService().total(new BigDecimal("12.35"), 0));
    }
    @Test public void roundsHalfUp() {
        assertEquals(new BigDecimal("1.24"), new PriceService().total(new BigDecimal("1.235"), 1));
    }
    @Test(expected = IllegalArgumentException.class) public void rejectsNullPrice() {
        new PriceService().total(null, 1);
    }
    @Test(expected = IllegalArgumentException.class) public void rejectsNegativePrice() {
        new PriceService().total(new BigDecimal("-1"), 1);
    }
    @Test(expected = IllegalArgumentException.class) public void rejectsNegativeQuantity() {
        new PriceService().total(BigDecimal.ONE, -1);
    }
}
