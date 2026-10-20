from decimal import Decimal


def json_default(value):
    """Convert DynamoDB numeric values without hiding unsupported types."""
    if isinstance(value, Decimal):
        if value == value.to_integral_value():
            return int(value)
        return float(value)
    raise TypeError(f"Object of type {type(value).__name__} is not JSON serializable")
